// 渲染进度：让「渲染中」变成「找素材 25% / 渲染画面 68%」，并且能在后台跑。
//
// 上游的 status 只有 processing/ready/failed 三种，进度只在 Remotion 内部
// 以日志形式出现。这里做一个小型全局进度表（globalThis.__SW_PROGRESS__）：
//
//   ShortCreator 在阶段边界写 queue/audio/search/download/render/done；
//   Remotion.render 的 onProgress 把 0–1 映射到 40–95%。
//
// 状态接口和列表接口都带上 progress，前端轮询列表即可看到每个任务的阶段。
// 进度表是进程内的：容器重启后正在跑的任务会回到「渲染中、无百分比」，不影
// 响出片，只影响展示。
const fs = require("fs");

const D = "/app/dist";
const MARKER = "// progress: v1";
let touched = 0;

function edit(label, file, pairs) {
  if (!fs.existsSync(file)) throw new Error(`${label}: missing ${file}`);
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(MARKER)) {
    console.log("already patched", file);
    return;
  }
  for (const [from, to] of pairs) {
    if (!source.includes(from)) throw new Error(`${label}: anchor not found: ${from.slice(0, 60)}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(file, source);
  touched += 1;
  console.log("patched", file);
}

// ---- ShortCreator: 阶段边界 -------------------------------------------------
edit("short creator", `${D}/short-creator/ShortCreator.js`, [
  [
    `    async createShort(videoId, inputScenes, config) {`,
    `    async createShort(videoId, inputScenes, config) {
        __setProgress(videoId, "queue", 3);`,
  ],
  [
    `        for (const scene of inputScenes) {`,
    `        for (const scene of inputScenes) {
            const __baseProgress = 5 + (index / Math.max(1, inputScenes.length)) * 30;`,
  ],
  [
    `            // audio:prebuilt v1`,
    `            __setProgress(videoId, "audio", __baseProgress + 2);
            // audio:prebuilt v1`,
  ],
  [
    `            const video = await this.pexelsApi.findVideo(scene.searchTerms, audioLength, excludeVideoIds, orientation);`,
    `            __setProgress(videoId, "search", __baseProgress + 12);
            const video = await this.pexelsApi.findVideo(scene.searchTerms, audioLength, excludeVideoIds, orientation);`,
  ],
  [
    `            excludeVideoIds.push(video.id);`,
    `            __setProgress(videoId, "download", __baseProgress + 18);
            excludeVideoIds.push(video.id);`,
  ],
  [
    `        await this.remotion.render({`,
    `        __setProgress(videoId, "render", 40);
        await this.remotion.render({`,
  ],
  [
    `        }, videoId, orientation);`,
    `        }, videoId, orientation);
        __setProgress(videoId, "done", 100);`,
  ],
]);

// 进度方法：挂在原型上，避免在 class 内部找锚点。
edit("short creator progress method", `${D}/short-creator/ShortCreator.js`, [
  [
    `exports.ShortCreator = ShortCreator;`,
    `exports.ShortCreator = ShortCreator;

${MARKER}
const __SW_PROGRESS = (globalThis.__SW_PROGRESS__ = globalThis.__SW_PROGRESS__ || new Map());
function __setProgress(id, stage, percent) {
    __SW_PROGRESS.set(id, {
        stage,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        updatedAt: Date.now(),
    });
}
ShortCreator.prototype.progress = function (id) {
    return __SW_PROGRESS.get(id) || null;
};`,
  ],
]);

// ---- Remotion: 渲染百分比 ---------------------------------------------------
const renderLogger = '                logger_1.logger.debug(`Rendering ${id} ${Math.floor(progress * 100)}% complete`);';
edit("remotion", `${D}/short-creator/libraries/Remotion.js`, [
  [
    renderLogger,
    `                __setRenderProgress(id, progress);
${renderLogger}`,
  ],
  [
    `exports.Remotion = Remotion;`,
    `exports.Remotion = Remotion;

${MARKER}
function __setRenderProgress(id, progress) {
    const store = globalThis.__SW_PROGRESS__ || (globalThis.__SW_PROGRESS__ = new Map());
    store.set(id, {
        stage: "render",
        percent: Math.min(95, 40 + Math.round(progress * 55)),
        updatedAt: Date.now(),
    });
}`,
  ],
]);

// ---- REST: 状态与列表带上 progress -----------------------------------------
edit("rest status", `${D}/server/routers/rest.js`, [
  [
    `            const status = this.shortCreator.status(videoId);
            res.status(200).json({
                status,
            });`,
    `            const status = this.shortCreator.status(videoId);
            const progress = typeof this.shortCreator.progress === "function" ? this.shortCreator.progress(videoId) : null;
            res.status(200).json({
                status,
                progress,
            });`,
  ],
  [
    `        this.router.get("/short-videos", (req, res) => {
            const videos = this.shortCreator.listAllVideos();
            res.status(200).json({
                videos,
            });
        });`,
    `        this.router.get("/short-videos", (req, res) => {
            const videos = this.shortCreator.listAllVideos().map((video) => ({
                ...video,
                progress: video.status === "processing" && typeof this.shortCreator.progress === "function"
                    ? this.shortCreator.progress(video.id)
                    : null,
            }));
            res.status(200).json({
                videos,
            });
        });`,
  ],
]);

if (!touched) console.log("progress patch already applied");
else console.log("progress patch applied");
