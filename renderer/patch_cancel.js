// 取消正在渲染的任务。
//
// 渲染器没有取消接口，Remotion 的 renderMedia 支持 cancelSignal。这里：
//   - ShortCreator.createShort 为每个任务建一个 {cancelled, cancel}；
//   - 阶段边界检查 cancelled，渲染中由 Remotion 的 cancel signal 中断；
//   - cancel(id) 只从队列里删「还没开始」的任务（index > 0）；正在跑的是
//     queue[0]，不能 splice，否则 processQueue 的 finally shift 会删错下一个；
//   - 渲染失败/取消后删掉可能写了一半的 mp4，避免 status() 把它当成 ready。
const fs = require("fs");

const D = "/app/dist";

function edit(label, file, pairs) {
  if (!fs.existsSync(file)) throw new Error(`${label}: missing ${file}`);
  let source = fs.readFileSync(file, "utf8");
  if (source.includes("// cancel: v1")) {
    console.log("already patched", file);
    return;
  }
  for (const [from, to] of pairs) {
    if (!source.includes(from)) throw new Error(`${label}: anchor not found: ${from.slice(0, 60)}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(file, source);
  console.log("patched", file);
}

const check = `        if (__cancel.cancelled) throw new Error("Cancelled");`;

edit("short creator", `${D}/short-creator/ShortCreator.js`, [
  [
    `        __setProgress(videoId, "queue", 3);`,
    `        __setProgress(videoId, "queue", 3);
        const __cancel = { cancelled: false, cancel: null };
        __SW_CANCEL.set(videoId, __cancel);`,
  ],
  [
    `            __setProgress(videoId, "audio", __baseProgress + 2);`,
    `            __setProgress(videoId, "audio", __baseProgress + 2);
${check}`,
  ],
  [
    `            __setProgress(videoId, "search", __baseProgress + 12);`,
    `            __setProgress(videoId, "search", __baseProgress + 12);
${check}`,
  ],
  [
    `            __setProgress(videoId, "download", __baseProgress + 18);`,
    `            __setProgress(videoId, "download", __baseProgress + 18);
${check}`,
  ],
  [
    `        __setProgress(videoId, "render", 40);`,
    `        __setProgress(videoId, "render", 40);
${check}`,
  ],
  [
    `        await this.remotion.render({`,
    `        try {
        await this.remotion.render({`,
  ],
  [
    `        }, videoId, orientation);
        __setProgress(videoId, "done", 100);`,
    `        }, videoId, orientation, __cancel);
        } catch (__renderError) {
            try { fs_extra_1.default.removeSync(this.getVideoPath(videoId)); } catch (_) { }
            throw __renderError;
        }
        __setProgress(videoId, "done", 100);`,
  ],
  [
    `        return videoId;`,
    `        __SW_CANCEL.delete(videoId);
        return videoId;`,
  ],
  [
    `exports.ShortCreator = ShortCreator;`,
    `exports.ShortCreator = ShortCreator;

// cancel: v1
const __SW_CANCEL = (globalThis.__SW_CANCEL__ = globalThis.__SW_CANCEL__ || new Map());
ShortCreator.prototype.cancel = function (id) {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index > 0) {
        this.queue.splice(index, 1);
        return true;
    }
    if (index === 0) {
        const entry = __SW_CANCEL.get(id);
        if (!entry) return false;
        entry.cancelled = true;
        if (typeof entry.cancel === "function") entry.cancel();
        return true;
    }
    return false;
};`,
  ],
]);

edit("remotion", `${D}/short-creator/libraries/Remotion.js`, [
  [
    `    async render(data, id, orientation) {`,
    `    async render(data, id, orientation, cancelState) {`,
  ],
  [
    `        logger_1.logger.debug({ component, videoID: id }, "Rendering video with Remotion");
        const outputLocation = path_1.default.join(this.config.videosDirPath, \`\${id}.mp4\`);`,
    `        logger_1.logger.debug({ component, videoID: id }, "Rendering video with Remotion");
        const outputLocation = path_1.default.join(this.config.videosDirPath, \`\${id}.mp4\`);
        let cancelSignal;
        if (cancelState) {
            const { makeCancelSignal } = require("@remotion/renderer");
            const signal = makeCancelSignal();
            cancelSignal = signal.cancelSignal;
            cancelState.cancel = signal.cancel;
            if (cancelState.cancelled) signal.cancel();
        }`,
  ],
  [
    `            serveUrl: this.bundled,
            outputLocation,
            inputProps: data,`,
    `            serveUrl: this.bundled,
            outputLocation,
            inputProps: data,
            cancelSignal,`,
  ],
]);

edit("rest cancel", `${D}/server/routers/rest.js`, [
  [
    `        this.router.get("/tmp/:tmpFile", (req, res) => {`,
    `        this.router.post("/short-video/:videoId/cancel", (req, res) => {
            const { videoId } = req.params;
            const ok = this.shortCreator.cancel(videoId);
            res.status(ok ? 200 : 404).json({ ok });
        });
        this.router.get("/tmp/:tmpFile", (req, res) => {`,
  ],
]);

// processQueue 的错误日志带上 videoId，前端/工作台才能对应到具体任务。
const scPath = `${D}/short-creator/ShortCreator.js`;
let sc = fs.readFileSync(scPath, "utf8");
const errorFrom = `            logger_1.logger.error(error, "Error creating video");`;
const errorTo = `            logger_1.logger.error({ err: error, videoId: id }, "Error creating video");`;
if (sc.includes(errorFrom)) {
  fs.writeFileSync(scPath, sc.replace(errorFrom, errorTo));
  console.log("patched error log with videoId");
} else if (!sc.includes("videoId: id }, \"Error creating video\"")) {
  throw new Error("error log anchor not found");
}

console.log("cancel patch applied");
