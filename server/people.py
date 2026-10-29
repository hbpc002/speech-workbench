"""无人物素材过滤：判断一条 Pexels 视频里有没有人。

Pexels 的搜索接口没有「不要人物」这个筛选项，返回的元数据里也没有可靠的
人物标记（`tags` 在搜索结果里是空的，`url` slug 只是标题的拼音化）。所以这里
做两层过滤，成本从低到高：

1. **slug 黑名单**：Pexels 视频 URL 形如
   `/video/man-holding-a-cup-of-coffee-6343885/`，标题里带 man / woman / hands
   的基本都有人。这一步零成本，能挡掉大部分。
2. **预览帧检测**：Pexels 给每条视频 4 张 `video_pictures` 和一张 `image` 封面。
   下载其中最多 `PEOPLE_MAX_IMAGES` 张，跑 YOLOv8n（ONNX）的 person 类。任何
   一帧检出人，就整条剔除。

为什么不只靠 slug：`peaceful-park-walk-on-cloudy-day` 这种标题看不出人，帧里
可能有人；反过来 `human-made` 这种词会误伤，所以按 `-` 切词后精确匹配。

模型不可用（没有 onnxruntime、模型文件缺失、下载失败）时**放行**并在日志里
报警：过滤是"尽量别出现人"，不该让整个短视频功能因为一个可选依赖缺失而瘫痪。
真正要求零人物的场景，启动时 `/health` 会报 `available=false`，看日志即可。
"""

import io
import os
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import requests

from . import config

# 按 `-` 切词后精确匹配。刻意包含 hand/hands/arm/arms：做饭、打字、翻书这类
# 素材经常只有一双手，但观感上仍然是"有人"。
PERSON_WORDS = {
    "man", "men", "woman", "women", "person", "persons", "people", "girl",
    "girls", "boy", "boys", "child", "children", "kid", "kids", "baby",
    "babies", "toddler", "teen", "teenager", "adult", "human", "humans",
    "hand", "hands", "arm", "arms", "finger", "fingers", "face", "faces",
    "portrait", "selfie", "crowd", "crowds", "worker", "workers", "chef",
    "chefs", "doctor", "nurse", "teacher", "student", "students", "model",
    "models", "couple", "family", "friend", "friends", "guy", "lady",
    "gentleman", "athlete", "dancer", "singer", "musician", "colleagues",
    "coworker", "coworkers", "interview", "talking", "walking", "holding",
    "wearing", "sitting", "standing", "smiling", "laughing", "cooking",
    "typing", "writing", "reading", "playing", "working", "businessman",
    "businesswoman", "businesspeople", "barista", "baker", "farmer",
}

_session = None
_session_lock = threading.Lock()
_input_name = None
# None = 还没试过；False = 试过且不可用（缺 onnxruntime / 模型），不再重复尝试。
_available = None

_cache: "OrderedDict[int, bool]" = OrderedDict()
_cache_lock = threading.Lock()


# ---- 第一层：slug -----------------------------------------------------------


def slug_words(url: str) -> list[str]:
    """`.../video/man-holding-a-cup-of-coffee-6343885/` -> ['man', ...]."""
    slug = str(url or "").split("/video/")[-1].split("/")[0].split("?")[0]
    return [word for word in slug.split("-") if word]


def slug_has_person(url: str) -> bool:
    return any(word.lower() in PERSON_WORDS for word in slug_words(url))


# ---- 第二层：YOLOv8n --------------------------------------------------------


def _load_session():
    """Lazy so the module imports (and tests run) without onnxruntime."""
    global _session, _input_name
    if _session is not None:
        return _session
    with _session_lock:
        if _session is not None:
            return _session
        import onnxruntime as ort  # noqa: PLC0415 - optional dependency

        if not os.path.isfile(config.PEOPLE_MODEL_PATH):
            raise RuntimeError(f"人物检测模型不存在：{config.PEOPLE_MODEL_PATH}")
        session = ort.InferenceSession(config.PEOPLE_MODEL_PATH, providers=["CPUExecutionProvider"])
        _input_name = session.get_inputs()[0].name
        _session = session
        return _session


def available() -> bool:
    global _available
    if _available is None:
        try:
            _load_session()
            _available = True
        except Exception as exc:  # noqa: BLE001 - availability must never raise
            print(f"[people] detector unavailable: {exc}", flush=True)
            _available = False
    return _available


def _preprocess(raw: bytes):
    import numpy as np  # noqa: PLC0415 - optional dependency
    from PIL import Image  # noqa: PLC0415 - optional dependency

    image = Image.open(io.BytesIO(raw)).convert("RGB")
    width, height = image.size
    scale = min(640 / width, 640 / height)
    resized = image.resize((max(1, round(width * scale)), max(1, round(height * scale))))
    canvas = Image.new("RGB", (640, 640), (114, 114, 114))
    canvas.paste(resized, ((640 - resized.width) // 2, (640 - resized.height) // 2))
    array = np.asarray(canvas, dtype=np.float32) / 255.0
    return array.transpose(2, 0, 1)[None, ...]


def output_has_person(output) -> bool:
    """YOLOv8 export: (1, 84, 8400) = 4 box values + 80 class scores."""
    import numpy as np  # noqa: PLC0415

    array = np.asarray(output)
    if array.ndim == 3:
        array = array[0]
    if array.shape[0] < 5:
        return False
    # Row 4 is class 0 (person); the exporter already applies sigmoid.
    return bool((array[4] > config.PEOPLE_CONFIDENCE).any())


def _download(url: str) -> bytes:
    response = requests.get(
        url,
        timeout=(3, config.PEOPLE_IMAGE_TIMEOUT),
        headers={"User-Agent": "speech-workbench/1.0 (+people-filter)"},
    )
    response.raise_for_status()
    return response.content


def image_has_person(url: str) -> bool:
    session = _load_session()
    batch = _preprocess(_download(url))
    output = session.run(None, {_input_name: batch})[0]
    return output_has_person(output)


def _any_person(images: list[str]) -> bool:
    if not available():
        return False
    for url in images[: config.PEOPLE_MAX_IMAGES]:
        try:
            if image_has_person(url):
                return True
        except Exception as exc:  # noqa: BLE001 - one bad frame must not reject the clip
            print(f"[people] frame check failed ({url[:60]}): {exc}", flush=True)
    return False


# ---- 过滤入口 ---------------------------------------------------------------


def _cache_get(candidate_id):
    with _cache_lock:
        if candidate_id in _cache:
            _cache.move_to_end(candidate_id)
            return _cache[candidate_id]
    return None


def _cache_put(candidate_id, person_free: bool) -> None:
    if not config.PEOPLE_CACHE_SIZE:
        return
    with _cache_lock:
        _cache[candidate_id] = person_free
        _cache.move_to_end(candidate_id)
        while len(_cache) > config.PEOPLE_CACHE_SIZE:
            _cache.popitem(last=False)


def filter_candidates(candidates: list[dict], detect=None) -> dict:
    """Return the ids that pass both layers.

    `detect` is injectable so tests can run without onnxruntime. It receives a
    list of image URLs and returns True when a person is present.
    """
    detect = detect or _any_person
    items = [item for item in candidates if isinstance(item, dict)][: config.PEOPLE_MAX_CANDIDATES]
    results: dict[int, bool] = {}

    def check(item):
        candidate_id = item.get("id")
        if candidate_id is None:
            return
        try:
            candidate_id = int(candidate_id)
        except (TypeError, ValueError):
            return
        if slug_has_person(item.get("slug") or item.get("url") or ""):
            results[candidate_id] = False
            return
        cached = _cache_get(candidate_id)
        if cached is not None:
            results[candidate_id] = cached
            return
        images = [url for url in item.get("images") or [] if isinstance(url, str)]
        person_free = not detect(images) if images else True
        _cache_put(candidate_id, person_free)
        results[candidate_id] = person_free

    with ThreadPoolExecutor(max_workers=min(config.PEOPLE_WORKERS, len(items) or 1)) as pool:
        list(pool.map(check, items))

    allowed = sorted(candidate_id for candidate_id, ok in results.items() if ok)
    return {
        "allowed": allowed,
        "checked": len(results),
        "rejected": len(results) - len(allowed),
        "detector": available(),
    }


def handle(payload: dict) -> dict:
    """Shared by the HTTP service and the tests."""
    candidates = payload.get("candidates") if isinstance(payload, dict) else None
    if not isinstance(candidates, list):
        raise ValueError("candidates 必须是数组")
    return filter_candidates(candidates)

