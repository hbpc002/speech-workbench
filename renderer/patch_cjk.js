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

Whisper.prototype.CreateCaption = async function (audioPath) {
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
`;
fs.writeFileSync(p, s);
console.log("patched whisper plaintext mode");
