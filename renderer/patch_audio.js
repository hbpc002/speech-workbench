// 用现成音频 + 用口播稿做字幕。
//
// 两处改动：
// 1. ShortCreator：scene.audioUrl 存在时直接下载这段 WAV 当配音，跳过
//    kokoro.generate（也就是不再调 TTS 桥）。这样「先生成语音 → 再点视频」
//    不会把同一段话合成第二遍，情绪、音色、参数都和记录里完全一致。
// 2. 字幕不再跑 Whisper。直接把 scene.text（服务端已经去掉了情感标签）交给
//    Whisper.CreateCaption 的文本分支，按字数比例分配到音频时长上 ——
//    中文不会再被 Whisper 识别成英文/乱码，也省掉一次转写。
const fs = require("fs");

const D = "/app/dist";
const MARKER = "// audio:prebuilt v1";

function edit(label, file, fn) {
  if (!fs.existsSync(file)) throw new Error(`${label}: missing ${file}`);
  const source = fs.readFileSync(file, "utf8");
  const next = fn(source);
  if (next !== source) {
    fs.writeFileSync(file, next);
    console.log("patched", file);
  } else {
    console.log("no change", file);
  }
}

// 1) 场景 schema 接受 audioUrl / audioDuration
edit("scene schema", `${D}/types/shorts.js`, (s) => {
  if (s.includes("audioUrl:")) return s;
  const anchor = "exports.sceneInput = zod_1.default.object({";
  if (!s.includes(anchor)) throw new Error("sceneInput anchor not found");
  return s.replace(
    anchor,
    `${anchor}\n    audioUrl: zod_1.default.string().optional(),\n    audioDuration: zod_1.default.number().optional(),`
  );
});

// 2) createShort：有 audioUrl 就不合成
edit("short creator", `${D}/short-creator/ShortCreator.js`, (s) => {
  if (s.includes(MARKER)) return s;
  const from = `            const audio = await this.kokoro.generate(scene.text, config.voice ?? "af_heart");
            let { audioLength } = audio;
            const { audio: audioStream } = audio;`;
  const to = `            ${MARKER}
            // 语音记录里已经有合成好的 WAV 时，直接用，不再调 TTS。
            let audioStream;
            let audioLength;
            if (scene.audioUrl) {
                const __audioRes = await fetch(scene.audioUrl);
                if (!__audioRes.ok) throw new Error("Pre-generated audio fetch failed: " + __audioRes.status);
                audioStream = Buffer.from(await __audioRes.arrayBuffer());
                audioLength = scene.audioDuration;
            } else {
                const audio = await this.kokoro.generate(scene.text, config.voice ?? "af_heart");
                audioLength = audio.audioLength;
                audioStream = audio.audio;
            }`;
  if (!s.includes(from)) throw new Error("kokoro.generate block not found");
  return s.replace(from, to);
});

// 3) 字幕用文本，时长扣掉末尾留白
edit("captions call", `${D}/short-creator/ShortCreator.js`, (s) => {
  const from = `            const captions = await this.whisper.CreateCaption(tempWavPath);`;
  const to = `            const __speechSeconds = Math.max(0.3, audioLength - (index + 1 === inputScenes.length && config.paddingBack ? config.paddingBack / 1000 : 0));
            const captions = await this.whisper.CreateCaption(tempWavPath, scene.text, __speechSeconds);`;
  if (!s.includes(from)) throw new Error("CreateCaption call not found");
  return s.replace(from, to);
});

console.log("audio/captions patch applied");
