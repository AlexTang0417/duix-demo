import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Duix, toPcm16k } from "@dhmodel/duix-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const port = Number(process.env.PORT || 5179);

const duix = new Duix({
  baseDir: path.join(here, "model", "gj_dh_res"),
  roleDir: path.join(here, "model", "语熙"),
});

const state = {
  ready: false,
  error: "",
  info: null,
  blocks: 0,
  gen: 0,
  target: 0,
  face: 0,
  rawCache: new Map(),
  latest: null,
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function send(res, status, body, type, headers = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("audio too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function rawJpeg(index) {
  const n = state.info?.frames || 1;
  const slot = ((index % n) + n) % n;
  const hit = state.rawCache.get(slot);
  if (hit) return hit;
  const jpeg = await duix.renderJpeg(slot, null, 70);
  state.rawCache.set(slot, jpeg);
  return jpeg;
}

function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Same rule as RenderThread: drop stale lip tasks, keep only the newest index. */
async function lipLoop() {
  let renderedKey = "";
  for (;;) {
    const want = state.blocks > 0 ? Math.min(state.blocks - 1, Math.max(0, state.target)) : -1;
    const face = state.face | 0;
    const key = `${state.gen}:${face}:${want}`;
    if (want < 0 || key === renderedKey) {
      await sleep(8);
      continue;
    }
    try {
      const t0 = performance.now();
      const gen = state.gen;
      const frame = await duix.renderJpeg(face, want, 90);
      if (gen !== state.gen) continue;
      state.latest = {
        index: want,
        face,
        jpeg: frame,
        inferMs: Math.round(performance.now() - t0),
      };
      renderedKey = key;
    } catch (err) {
      console.error("lip", err);
      await sleep(40);
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/api/status") {
      send(res, 200, JSON.stringify({
        ready: state.ready,
        error: state.error,
        info: state.info,
        blocks: state.blocks,
      }), "application/json; charset=utf-8");
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/drive") {
      if (!state.ready) {
        send(res, 409, JSON.stringify({ error: state.error || "model not ready" }), "application/json; charset=utf-8");
        return;
      }
      const pcm = toPcm16k(await readBody(req));
      state.blocks = 0;
      state.latest = null;
      state.target = 0;
      state.face = 0;
      state.gen += 1;
      state.blocks = await duix.pushPcm(pcm);
      send(res, 200, wavFromPcm(duix.playbackPcm), "audio/wav", {
        "X-Blocks": String(state.blocks),
      });
      return;
    }
    const raw = url.pathname.match(/^\/api\/raw\/(\d+)\.jpg$/);
    if (req.method === "GET" && raw) {
      if (!state.ready) {
        send(res, 409, "model not ready", "text/plain; charset=utf-8");
        return;
      }
      send(res, 200, await rawJpeg(Number(raw[1])), "image/jpeg");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/clock") {
      const index = Number(url.searchParams.get("i") || 0);
      const face = Number(url.searchParams.get("f") || 0);
      if (Number.isFinite(index)) state.target = Math.max(0, index | 0);
      if (Number.isFinite(face)) state.face = Math.max(0, face | 0);
      const latest = state.latest;
      if (!latest) {
        send(res, 204, "", "text/plain");
        return;
      }
      send(res, 200, latest.jpeg, "image/jpeg", {
        "X-Index": String(latest.index),
        "X-Face": String(latest.face ?? 0),
        "X-Infer-Ms": String(latest.inferMs),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      send(res, 204, "", "image/x-icon");
      return;
    }
    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const file = path.join(publicDir, rel);
      if (!file.startsWith(publicDir)) {
        send(res, 403, "forbidden", "text/plain");
        return;
      }
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file);
        send(res, 200, fs.readFileSync(file), TYPES[ext] || "application/octet-stream");
        return;
      }
    }
    send(res, 404, "not found", "text/plain; charset=utf-8");
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`duix-demo http://127.0.0.1:${port}`);
});

duix.init().then(async (info) => {
  state.info = info;
  for (let i = 0; i < info.frames; i++) {
    state.rawCache.set(i, await duix.renderJpeg(i, null, 70));
    if ((i + 1) % 30 === 0 || i + 1 === info.frames) {
      console.log(`cached silence ${i + 1}/${info.frames}`);
    }
  }
  state.ready = true;
  console.log("model ready", info.width + "x" + info.height, "frames", info.frames);
  lipLoop();
}).catch((err) => {
  state.error = err.message;
  console.error(err);
});
