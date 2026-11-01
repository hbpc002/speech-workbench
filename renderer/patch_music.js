// 音乐音量档位：素材本身是很轻的库存音乐，原档位（0.2/0.45/0.7）在有人声时
// 基本听不见。构建时还会把 /app/static/music 全部 loudnorm 到 -14 LUFS，这里
// 再把档位抬一点，保证「轻」也能听见、又不盖过人声。
const fs = require("fs");

const FILE = "/app/dist/components/utils.js";
const MARKER = "// music-volume: v1";
let source = fs.readFileSync(FILE, "utf8");
if (source.includes(MARKER)) {
  console.log("music volume patch already applied");
  process.exit(0);
}

const pairs = [
  ['        case "low":\n            return [0.2, false];', '        case "low":\n            return [0.35, false];'],
  ['        case "medium":\n            return [0.45, false];', '        case "medium":\n            return [0.6, false];'],
  ['        case "high":\n            return [0.7, false];', '        case "high":\n            return [0.85, false];'],
];
for (const [from, to] of pairs) {
  if (!source.includes(from)) throw new Error(`music volume anchor not found: ${from.slice(0, 40)}`);
  source = source.replace(from, to);
}
source += `\n${MARKER}\n`;
fs.writeFileSync(FILE, source);
console.log("patched music volume levels");
