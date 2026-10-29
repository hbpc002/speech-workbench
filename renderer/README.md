# renderer/ —— 一体化镜像里对 short-video-maker 做的两处补丁

上游：[short-video-maker](https://github.com/gyoridavid/short-video-maker) v1.3.4（MIT），
`Dockerfile.allinone` 用它的 `latest-tiny` 镜像作为基础。

## patch_dist.js

对 `/app/dist` 做三件事：

1. `Kokoro.js`：把 `generate()` 整体替换成 POST `http://127.0.0.1:8101/tts`，
   并接受 `X-Duration` 作为这段音频的长度。这一处就是"短视频用你的复刻音色配音"
   的全部改动 —— 音频不再由渲染器自己合成，而是交给 `server/tts_bridge.py`，
   桥再调用 DashScope。
2. `types/shorts.js`：允许 `voice` 是任意字符串（上游 v1.3.4 已经放开，补丁保留
   是为了向前兼容老镜像）。
3. `components/videos/{Portrait,Landscape}Video.js`：字体加 "Noto Sans CJK SC"，
   中文句子之间不加空格（拉丁语系按空格换行，中文按字换行）。

## patch_cjk.js

`Whisper.js` 的中文字幕解析。`@remotion/install-whisper-cpp` 的默认解析会把一个
汉字的 UTF-8 字节切成两半，解出来是 `U+FFFD`（渲染成 `▣?`）。这个补丁让中文
直接跑 `whisper-cli` 的纯文本输出，按 `[from --> to]` 时间戳重排字幕，并再按
标点和 8 字上限切块。

## 为什么按 digest 固定基础镜像

两个补丁都是按 `dist` 里的**具体文本**做替换。上游镜像重建一次，文本就可能变，
补丁会静默失效（不报错，只是渲染回原样）。所以 `Dockerfile.allinone` 里写的是
`gyoridavid/short-video-maker:latest-tiny@sha256:...`。升级时先改 digest，再验证
`/api/video/options` 返回的 `renderer` 是 `ok`，并且真出一条片。

## entrypoint.sh

一个容器里跑两个进程：渲染器（`node dist/index.js`，只绑回环，端口
`VIDEO_RENDERER_PORT`）和本应用（uvicorn，对外端口 `PUBLIC_PORT`）。任一进程
退出就收掉另一个：渲染器活着但没有工坊等于白占一块 Chrome，工坊活着但渲染器
没了等于短视频页签永远在报错。
