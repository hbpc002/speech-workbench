const fs = require("fs");
const p = "/app/dist/short-creator/libraries/Whisper.js";
let s = fs.readFileSync(p, "utf8");
if (s.includes("// cjk:plaintext")) { console.log("already patched"); process.exit(0); }

// 去掉上一版基于 token 的补丁
const marker = "// cjk:CreateCaption";
const idx = s.indexOf(marker);
if (idx > 0) s = s.slice(0, idx);

s += `
// cjk:plaintext —— whisper.cpp 的 JSON/token 输出会把一个汉字的 UTF-8 字节切成两半，
// @remotion/install-whisper-cpp 解出来就是 U+FFFD（渲染成 ▣?）。whisper 的纯文本
// 输出是对的，所以中文直接跑二进制、解析 "[from --> to] 文本" 行。
const __origCreateCaption = Whisper.prototype.CreateCaption;
const __isCJKText = (t) => /[\\u3400-\\u9fff]/.test(t);
const __ms = (h, m, s, ms) => ((+h) * 3600 + (+m) * 60 + (+s)) * 1000 + (+ms);

Whisper.prototype.CreateCaption = async function (audioPath, text, durationSeconds) {
  // 有现成文本就直接用它做字幕：不给 Whisper 再次识别（中文小模型经常
  // 认成英文/乱码），也不用等转写。
  if (text && durationSeconds > 0) return __captionsFromText(text, durationSeconds);
  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const bin = path.join(this.config.whisperInstallPath, "main");
  const model = path.join(this.config.whisperInstallPath, "models", "ggml-" + this.config.whisperModel + ".bin");
  let raw = "";
  try {
    raw = execFileSync(bin, ["-m", model, "-f", audioPath, "-l", "auto"], {
      encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    return __origCreateCaption.call(this, audioPath);
  }
  const segs = [];
  for (const line of raw.split("\\n")) {
    const m = line.match(/^\\[(\\d+):(\\d+):(\\d+)[.,](\\d+)\\s*-->\\s*(\\d+):(\\d+):(\\d+)[.,](\\d+)\\]\\s*(.*)$/);
    if (!m) continue;
    const text = m[9].trim();
    if (text) segs.push({ from: __ms(m[1], m[2], m[3], m[4]), to: __ms(m[5], m[6], m[7], m[8]), text });
  }
  if (!segs.length || !__isCJKText(segs.map((x) => x.text).join(""))) {
    return __origCreateCaption.call(this, audioPath);
  }
  // 按标点/长度切块，时间按字数比例分
  const captions = [];
  const MAX = 8;
  for (const seg of segs) {
    const pieces = seg.text.split(/(?<=[，。！？、：；,.!?;])/).filter((x) => x.trim());
    const chunks = [];
    for (const piece of pieces) {
      const chars = [...piece.replace(/\\s+/g, "")];
      for (let i = 0; i < chars.length; i += MAX) chunks.push(chars.slice(i, i + MAX).join(""));
    }
    const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
    let t = seg.from;
    for (const c of chunks) {
      const span = ((seg.to - seg.from) * c.length) / total;
      captions.push({ text: c, startMs: Math.round(t), endMs: Math.round(t + span) });
      t += span;
    }
  }
  return captions;
};

// 文本字幕：去掉方括号标签，按标点切块（中文 8 字、西文 24 字符），按字数
// 比例分配时长。
const __captionClean = (text) =>
  String(text || "").replace(/\\[[^\\[\\]\\n]{0,48}\\]/g, "").replace(/\\s+/g, " ").trim();

function __captionChunks(text) {
  const clean = __captionClean(text);
  if (!clean) return [];
  const pieces = clean.split(/(?<=[，。！？、：；,.!?;])/).map((x) => x.trim()).filter(Boolean);
  const chunks = [];
  for (const piece of pieces) {
    if (/[\\u3400-\\u9fff]/.test(piece)) {
      const chars = [...piece];
      for (let i = 0; i < chars.length; i += 8) chunks.push(chars.slice(i, i + 8).join(""));
    } else {
      let line = "";
      for (const word of piece.split(/\\s+/)) {
        if (line && (line + " " + word).length > 24) {
          chunks.push(line);
          line = word;
        } else {
          line = line ? line + " " + word : word;
        }
      }
      if (line) chunks.push(line);
    }
  }
  return chunks.length ? chunks : [clean.slice(0, 24)];
}

function __captionsFromText(text, durationSeconds) {
  const chunks = __captionChunks(text);
  if (!chunks.length) return [];
  const totalMs = Math.max(300, Math.round(durationSeconds * 1000));
  const totalChars = chunks.reduce((n, c) => n + [...c].length, 0) || 1;
  let at = 0;
  return chunks.map((chunk) => {
    const span = Math.round(([...chunk].length / totalChars) * totalMs);
    const caption = { text: chunk, startMs: at, endMs: Math.min(totalMs, at + span) };
    at += span;
    return caption;
  });
}
`;
fs.writeFileSync(p, s);
console.log("patched whisper plaintext mode");
