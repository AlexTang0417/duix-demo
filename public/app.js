const statusEl = document.querySelector("#status");
const view = document.querySelector("#view");
const ctx = view.getContext("2d");
const fileEl = document.querySelector("#file");
const playEl = document.querySelector("#play");

let blocks = 0;
let frameCount = 138;
let playing = false;
let playGen = 0;
let mouthBusy = false;
let audioCtx = null;
let source = null;
let audioOrigin = 0;
let idleOrigin = 0;
let shown = null;
let idleText = "正在加载模型…";
const rawImages = new Map();

function loadRaw(index) {
  const slot = ((index % frameCount) + frameCount) % frameCount;
  const hit = rawImages.get(slot);
  if (hit) return hit;
  const pending = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("raw frame failed"));
    img.src = `/api/raw/${slot}.jpg`;
  });
  rawImages.set(slot, pending);
  return pending;
}

/** Silence clip plays forward, then backward, same as RenderThread. */
function silenceSlot(now = performance.now()) {
  const n = frameCount;
  if (n <= 1) return 0;
  const step = Math.floor((now - idleOrigin) / 40) % (n * 2);
  return step < n ? step : n * 2 - 1 - step;
}

function playIndex() {
  if (!audioCtx || blocks <= 0) return 0;
  const elapsed = Math.max(0, audioCtx.currentTime - audioOrigin);
  return Math.min(blocks - 1, Math.floor(elapsed * 25));
}

function paint() {
  if (playing && shown?.bitmap) {
    ctx.drawImage(shown.bitmap, 0, 0);
    return;
  }
  const img = rawImages.get(silenceSlot());
  if (img && typeof img.then !== "function") ctx.drawImage(img, 0, 0);
}

function loop() {
  paint();
  if (playing) {
    const index = playIndex();
    const lip = shown ? shown.index : "-";
    const ms = shown ? shown.inferMs : "-";
    statusEl.textContent = `播放 ${index}/${blocks}，口型 ${lip}，推理 ${ms} ms`;
  }
  requestAnimationFrame(loop);
}

async function waitReady() {
  for (;;) {
    const data = await fetch("/api/status").then((r) => r.json());
    if (data.error && !data.ready) {
      statusEl.textContent = data.error;
      return;
    }
    if (data.ready) {
      frameCount = data.info.frames || frameCount;
      view.width = data.info.width;
      view.height = data.info.height;
      for (let i = 0; i < frameCount; i++) {
        const img = await loadRaw(i);
        rawImages.set(i, img);
        if (i % 20 === 0) statusEl.textContent = `缓存静默帧 ${i + 1}/${frameCount}`;
      }
      idleOrigin = performance.now();
      idleText = `静默循环 ${data.info.width}×${data.info.height}，${frameCount} 帧`;
      statusEl.textContent = idleText;
      loop();
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

fileEl.addEventListener("change", () => {
  playEl.disabled = !fileEl.files?.length;
  if (fileEl.files?.[0]) statusEl.textContent = fileEl.files[0].name;
});

function stopPlayback() {
  playing = false;
  if (source) {
    source.onended = null;
    try { source.stop(); } catch { /* already stopped */ }
    source.disconnect();
    source = null;
  }
  if (shown?.bitmap) shown.bitmap.close();
  shown = null;
}

function returnToIdle() {
  if (shown?.bitmap) shown.bitmap.close();
  shown = null;
  playing = false;
  statusEl.textContent = idleText;
}

playEl.addEventListener("click", async () => {
  const file = fileEl.files?.[0];
  if (!file) return;
  stopPlayback();
  const gen = ++playGen;
  playing = true;
  playEl.disabled = true;
  if (!audioCtx) audioCtx = new AudioContext();
  await audioCtx.resume();
  statusEl.textContent = "正在计算音频特征…";
  try {
    const res = await fetch("/api/drive", { method: "POST", body: await file.arrayBuffer() });
    if (gen !== playGen) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "驱动失败" }));
      throw new Error(err.error || "驱动失败");
    }
    blocks = Number(res.headers.get("X-Blocks"));
    const wav = await res.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(wav.slice(0));
    source = audioCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(audioCtx.destination);
    source.onended = () => {
      if (gen !== playGen) return;
      returnToIdle();
    };
    audioOrigin = audioCtx.currentTime;
    source.start();
    playEl.disabled = false;
    pullMouth(gen);
  } catch (err) {
    if (gen !== playGen) return;
    statusEl.textContent = err.message;
    stopPlayback();
    statusEl.textContent = err.message;
    playEl.disabled = !fileEl.files?.length;
  }
});

async function pullMouth(gen) {
  while (playing && gen === playGen) {
    if (mouthBusy) {
      await new Promise((r) => setTimeout(r, 8));
      continue;
    }
    mouthBusy = true;
    const index = playIndex();
    const face = silenceSlot();
    try {
      const res = await fetch(`/api/clock?i=${index}&f=${face}`);
      if (gen !== playGen || !playing) break;
      if (res.status === 200) {
        const lipIndex = Number(res.headers.get("X-Index"));
        const lipFace = Number(res.headers.get("X-Face"));
        if (!shown || shown.index !== lipIndex || shown.face !== lipFace) {
          const bitmap = await createImageBitmap(await res.blob());
          if (gen !== playGen || !playing) {
            bitmap.close();
            break;
          }
          if (shown?.bitmap) shown.bitmap.close();
          shown = {
            bitmap,
            index: lipIndex,
            face: lipFace,
            inferMs: res.headers.get("X-Infer-Ms"),
          };
        }
      }
    } catch {
      /* keep the last frame */
    } finally {
      mouthBusy = false;
    }
  }
}

waitReady();
