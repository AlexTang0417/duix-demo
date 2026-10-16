# duix-demo

浏览器页面，驱动逻辑来自本地包 `@dhmodel/duix-sdk`。

```bash
cd js/duix-demo
npm install
npm run dev
```

打开 http://127.0.0.1:5179 。播放时钟每 40ms 前进一帧，不等待口型。口型线程只保留最新帧，算完贴到当前画面上，和 `client` 的渲染循环一致。

模型在 `model/` 下，相对 `server.js` 加载：

- `model/gj_dh_res`：`wenet.o`、`weight_168u.b`
- `model/语熙`：`config.j`、`bbox.j`、`raw_jpgs`、`wasm/dh_model.wasm`
