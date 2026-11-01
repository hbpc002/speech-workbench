// 工作台选好的素材：scene.videoUrl 存在时跳过 Pexels 搜索，直接下载这条。
//
// 这样素材库/预览里选中的片段就是成片里用的那一条，不再由渲染器随机挑。
const fs = require("fs");

const D = "/app/dist";

function edit(label, file, pairs) {
  if (!fs.existsSync(file)) throw new Error(`${label}: missing ${file}`);
  let source = fs.readFileSync(file, "utf8");
  if (source.includes("// video-url: v1")) {
    console.log("already patched", file);
    return;
  }
  for (const [from, to] of pairs) {
    if (!source.includes(from)) throw new Error(`${label}: anchor not found: ${from.slice(0, 50)}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(file, source);
  console.log("patched", file);
}

edit("scene schema", `${D}/types/shorts.js`, [
  [
    `exports.sceneInput = zod_1.default.object({`,
    `exports.sceneInput = zod_1.default.object({
    videoUrl: zod_1.default.string().optional(),
    videoId: zod_1.default.string().optional(),`,
  ],
]);

edit("short creator", `${D}/short-creator/ShortCreator.js`, [
  [
    `            const video = await this.pexelsApi.findVideo(scene.searchTerms, audioLength, excludeVideoIds, orientation);`,
    `            // video-url: v1 —— 工作台/素材库指定了片段就不再搜索。
            const video = scene.videoUrl
                ? { id: scene.videoId || scene.videoUrl, url: scene.videoUrl, width: 0, height: 0 }
                : await this.pexelsApi.findVideo(scene.searchTerms, audioLength, excludeVideoIds, orientation);`,
  ],
]);

console.log("videoUrl patch applied");
