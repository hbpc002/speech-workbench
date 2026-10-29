// 无人物素材：把 Pexels 选片这一步换成"先问本地过滤器"。
//
// 上游 Pexels.js 从 80 条候选里随机挑一条，完全不看内容。这里做两件事：
//   1. 候选对象补上 slug / 封面 / 预览帧，交给 127.0.0.1:8102 的检测服务；
//   2. 只保留服务说"没人"的候选；一条都不剩就让这次搜索失败，由上层换检索词
//      （包括 findVideo 自带的 jokerTerms 兜底），而不是随便挑一条有人物的。
//
// 检测服务不可达时退回只看 slug 的本地黑名单：宁可退化成"尽量没人"，也不让
// 整个短视频功能因为一个辅助服务挂掉。
const fs = require("fs");

const FILE = "/app/dist/short-creator/libraries/Pexels.js";
const MARKER = "// people-filter: v1";
let source = fs.readFileSync(FILE, "utf8");

if (source.includes(MARKER)) {
  console.log("people patch already applied");
  process.exit(0);
}

const candidateFrom = `                        return {
                            id: video.id,
                            url: file.link,
                            width: file.width,
                            height: file.height,
                        };`;
const candidateTo = `                        return {
                            id: video.id,
                            url: file.link,
                            width: file.width,
                            height: file.height,
                            slug: video.url,
                            image: video.image,
                            pictures: (video.video_pictures || []).map((p) => p.picture),
                        };`;

const selectFrom = `        const video = filteredVideos[Math.floor(Math.random() * filteredVideos.length)];`;
const selectTo = `        const __safe = await __personFreeVideos(filteredVideos, searchTerm);
        if (!__safe.length) {
            logger_1.logger.error({ searchTerm, candidates: filteredVideos.length }, "No person-free videos found");
            throw new Error("No videos found");
        }
        const video = __safe[Math.floor(Math.random() * __safe.length)];`;

const jokerFrom = `const jokerTerms = ["nature", "globe", "space", "ocean"];`;
const jokerTo = `const jokerTerms = ["nature", "globe", "space", "ocean", "landscape", "forest", "mountains", "sky", "flowers", "abstract", "texture", "water"];`;

function replaceOnce(label, from, to) {
  if (!source.includes(from)) {
    throw new Error(`${label} not found in ${FILE}; upstream dist changed`);
  }
  source = source.replace(from, to);
}

replaceOnce("candidate return", candidateFrom, candidateTo);
replaceOnce("selection", selectFrom, selectTo);
replaceOnce("joker terms", jokerFrom, jokerTo);

source += `
${MARKER}
const __PERSON_FILTER_URL = "http://127.0.0.1:8102/people";
// 检测服务挂掉时的降级黑名单，和 server/people.py 的词表保持同源（子集）。
const __PERSON_WORDS = new Set([
  "man", "men", "woman", "women", "person", "persons", "people", "girl", "boy",
  "child", "children", "kid", "kids", "baby", "hand", "hands", "arm", "arms",
  "face", "faces", "portrait", "crowd", "worker", "chef", "doctor", "nurse",
  "teacher", "student", "model", "couple", "family", "friend", "friends",
  "guy", "lady", "athlete", "dancer", "singer", "musician", "colleagues",
  "interview", "talking", "walking", "holding", "wearing", "sitting",
  "standing", "smiling", "laughing", "cooking", "typing", "writing",
  "reading", "playing", "working", "barista", "baker", "farmer",
]);

function __slugLooksHuman(url) {
  const slug = String(url || "").split("/video/").pop().split("/")[0].split("?")[0];
  return slug.split("-").some((word) => __PERSON_WORDS.has(word.toLowerCase()));
}

async function __personFreeVideos(candidates, searchTerm) {
  const payload = {
    candidates: candidates.map((item) => ({
      id: item.id,
      slug: item.slug || "",
      images: [item.image, ...(item.pictures || [])].filter(Boolean).slice(0, 3),
    })),
  };
  try {
    const response = await fetch(__PERSON_FILTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error("people filter HTTP " + response.status);
    const data = await response.json();
    const allowed = new Set((data.allowed || []).map(Number));
    const kept = candidates.filter((item) => allowed.has(Number(item.id)));
    logger_1.logger.info(
      { searchTerm, total: candidates.length, kept: kept.length, rejected: data.rejected, detector: data.detector },
      "people filter"
    );
    return kept;
  } catch (error) {
    logger_1.logger.warn(error, "people filter unavailable, falling back to slug filter");
    return candidates.filter((item) => !__slugLooksHuman(item.slug));
  }
}
`;

fs.writeFileSync(FILE, source);
console.log("patched people filter into Pexels.js");
