const fs = require("fs");
const D = "/app/dist";

function edit(p, fn) {
  if (!fs.existsSync(p)) { console.log("skip", p); return; }
  const s = fs.readFileSync(p, "utf8");
  const t = fn(s);
  if (t !== s) { fs.writeFileSync(p, t); console.log("patched", p); }
  else console.log("no change", p);
}

// 1) Allow string voice in schema
edit(D + "/types/shorts.js", (s) => {
  return s.replace(
    /voice:\s*zod_1\.default\s*\.nativeEnum\(VoiceEnum\)/g,
    'voice: zod_1.default.string()'
  );
});

// 2) TTS bridge integration in Kokoro.js
edit(D + "/short-creator/libraries/Kokoro.js", (s) => {
  if (s.includes("edge-tts bridge")) return s;
  return s + `
Kokoro.init = async function () { return new Kokoro(null); };
Kokoro.prototype.generate = async function (text, voice) {
  const r = await fetch("http://127.0.0.1:8101/tts", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({text, voice})});
  if (!r.ok) throw new Error("TTS bridge failed " + r.status + ": " + (await r.text()));
  const audio = await r.arrayBuffer();
  const audioLength = parseFloat(r.headers.get("x-duration") || "0");
  return { audio, audioLength };
};
Kokoro.prototype.listAvailableVoices = function () {
  return [
    "cosyvoice",
    "qwen",
    "zh-CN-YunxiNeural",
    "zh-CN-XiaoxiaoNeural",
    "af_heart",
    "am_adam"
  ];
};
`;
});

// 3) Font family & CJK spacing in Remotion components
for (const f of ["PortraitVideo", "LandscapeVideo"]) {
  edit(`${D}/components/videos/${f}.js`, (s) => {
    let t = s;
    if (!t.includes("Noto Sans CJK SC")) {
      t = t.replace(/fontFamily: fontFamily,/g, 'fontFamily: fontFamily + \', "Noto Sans CJK SC", "Noto Sans SC", sans-serif\',');
    }
    if (!t.includes("/[\\u4e00-\\u9fff]/")) {
      t = t.replace(/text\.text, `scene-\$\{i\}-page-\$\{j\}-line-\$\{k\}-text-\$\{l\}`\)/,
        'text.text, `scene-${i}-page-${j}-line-${k}-text-${l}`)');
      t = t.replace('l < line.texts.length - 1 ? " " : ""',
        'l < line.texts.length - 1 ? (/[\\u4e00-\\u9fff]/.test(text.text) ? "" : " ") : ""');
    }
    return t;
  });
}
