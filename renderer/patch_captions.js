// 修复上游 createCaptionPages 的「第一页起晚了」。
//
// utils.js 里 currentPage.startMs 初始化为 0，而更新逻辑是：
//   if (i === 0 || currentPage.startMs === 0) startMs = caption.startMs;
// 于是只要第一页从 0 开始，后面每条字幕都会把 startMs 改成自己的时间，
// 最后第一页的起点变成**最后一条**字幕的起点 —— 声音早就出来了，字幕却要
// 等到这一页最后一句才显示。用一个 null 哨兵替代 0 即可，页面仍然取
// 最小起点，0 是合法值。
const fs = require("fs");

const FILE = "/app/dist/components/utils.js";
const MARKER = "// captions: page-start v1";
let source = fs.readFileSync(FILE, "utf8");
if (source.includes(MARKER)) {
  console.log("captions patch already applied");
  process.exit(0);
}

const initFrom = `    let currentPage = {
        startMs: 0,
        endMs: 0,
        lines: [],
    };`;
const initTo = `    let currentPage = {
        startMs: null,
        endMs: 0,
        lines: [],
    };`;

const updateFrom = `        if (i === 0 || currentPage.startMs === 0) {
            currentPage.startMs = caption.startMs;
        }
        else {
            currentPage.startMs = Math.min(currentPage.startMs, caption.startMs);
        }`;
const updateTo = `        if (currentPage.startMs === null) {
            currentPage.startMs = caption.startMs;
        }
        else {
            currentPage.startMs = Math.min(currentPage.startMs, caption.startMs);
        }`;

if (!source.includes(initFrom)) throw new Error("createCaptionPages init anchor not found");
if (!source.includes(updateFrom)) throw new Error("createCaptionPages update anchor not found");
source = source.replace(initFrom, initTo).replace(updateFrom, updateTo);
source += `\n${MARKER}\n`;
fs.writeFileSync(FILE, source);
console.log("patched caption page start");
