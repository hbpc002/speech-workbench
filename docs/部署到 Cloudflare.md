# 部署到 Cloudflare Workers —— 可行性研究

> 研究时间：2026-10。依据 Cloudflare 官方文档（Python Workers / FastAPI /
> WebSockets / R2 / 标准库）与官方示例（python-workers-examples）。

## 结论（先看这个）

**能部署到 Cloudflare，但不是「改个配置就上线」。** 它需要一次**中等规模的
WebSocket 层改写**，原因见下。**只想要语音合成 + 声音复刻**的场景，现状的
Render/Vercel 已经是最优解；选 Cloudflare 的理由主要是**免费额度更宽松**和
**域名托管在同一家**。

一句话定性：**这个仓库是一套 FastAPI 单体应用，而 Cloudflare 的运行模型是
「无服务器的函数 + 绑定」**。Vercel 几乎一比一复刻了前者，所以几乎零改动；
Cloudflare 需要把少数阻塞点改成它「函数优先」的写法。

---

## 现状：Cloudflare 上能不能直接跑？

Cloudflare 从 2025 年底开始提供「一等公民」的 Python Workers（跑在 Pyodide /
CPython-to-WASM 上），官方模板直接支持 **FastAPI**。所以这个仓库的骨架是能
带过去的。但逐个能力过一遍，结论差别很大：

| 能力 | 现状 | 能不能直接上 Workers |
|---|---|---|
| FastAPI 外壳 / 静态页面 / 登录鉴权 / REST | 纯 ASGI | ✅ 官方 asgi shim 直接挂 |
| 声音复刻存储（local/blob） | storage.py | ⚠️ 需换 R2（本仓库已加 r2 后端） |
| /ws/chat 实时对话 | Starlette + websockets 库双向代理 | ❌ 需 JS FFI 改写 |
| /ws/asr 实时识别 | 同上 | ❌ 需 JS FFI 改写 |
| /ws/tts 语音合成 | 同上 | ❌ 需 JS FFI 改写 |
| dashscope SDK / requests / ThreadPoolExecutor | api_voices.py | ❌ threading 不可用 |

---

## 三个阻塞点（都来自 Pyodide 的约束）

### 1. WebSocket：Python 的 websockets 库不可用

Workers 的 Python 是 Pyodide，**不提供 Python 的 `websockets` 库**。官方文档明确
说：*"In the future, we plan to provide support for native Python websocket APIs"* ——
也就是**现在还没有**。所有出站/入站 WebSocket 只能走 **JS FFI**（`js.WebSocket`），
这是 Workers 的底层运行时 WebSocket（支持代理、消息、关闭帧转发）。

本仓库的三个 /ws/* 端点都是「浏览器 → 本服务 → DashScope 上游」的**透明双向代理**
（见 server/ws_chat.py、ws_asr.py、ws_tts.py），逻辑核心是两段泵（upstream 泵和
browser 泵）。改写路径：

- 入站：FastAPI 的 `@app.websocket` 在 asgi shim 上支持有限，建议在 worker 的
  `fetch` 里直接用 `js.WebSocketPair` + `accept` 拦截升级请求，而不是走 FastAPI。
- 出站：用 `js.WebSocket.new(upstream_url)` 连 DashScope，把 browser 与上游两个
  socket 互相转发。`allowHalfOpen` 正好是官方为代理场景准备的（关闭帧要跨两侧协调）。

这是**唯一真正需要动手的部分**，工作量主要集中在这三个文件。

### 2. 阻塞式网络：threading 在 Pyodide 上不工作

server/api_voices.py 用 `dashscope` SDK（内部是 requests）+ `ThreadPoolExecutor`
+ Starlette 的 `run_in_threadpool` 做复刻/列表等**阻塞调用**。Pyodide 文档明说：
*"threading ... importable, but not functional"*。也就是说线程池里的代码不会真正
并发，阻塞调用会卡住整个 isolate 的事件循环。

这部分要么换成 async 写法，要么绕开 dashscope SDK 直接打 HTTP。声音复刻的列表
已经是裸 HTTP（`requests.get`），问题集中在 enroll 那一步。

### 3. 本地存储不持久：要换 R2

Pyodide 的文件系统在内存里，isolate 一回收就没了，所以 local 后端在 Workers 上
没意义。声音复刻需要「样本能被子同一个公网 URL 回源下载」，正好是 **R2** 的活。
**这个仓库已经加好了 r2 后端**（见 server/storage.py 的 `_check_r2` / `_put_r2`），
用 `set_r2_bucket()` 把 Workers 的 bucket 绑定按请求注入，并配 `R2_PUBLIC_BUCKET_URL`
做公网回源。cloudflare/ 脚手架里已经接好了。

---

## 需要（并已经做）的改动

1. **storage.py**：新增 `r2` 存储后端 + `set_r2_bucket()/get_r2_bucket()` 绑定注入，
   自检与上传路径都有中文报错，已带单元测试。
2. **config.py**：新增 `R2_PUBLIC_BUCKET_URL` 环境变量。
3. **cloudflare/ 脚手架**：`wrangler.toml` + `src/worker.py`（FastAPI 挂载 + R2 注入）+
   `pyproject.toml` + README。

**没改、也不建议在仓库里硬写**的：三个 /ws 文件的 JS FFI 改写。它是平台专属、
体积不小、而且目前无真实 CF 环境没法端到端测。代码留在本地，等你真上 Workers 时
再改，不会污染现在的 Vercel/Render/Docker 路径。

---

## Cloudflare 免费版够不够用

以 2026 年的 Workers 免费计划为准：

- 请求数：每天 10 万，够个人用。
- 出站 WebSocket：免费计划对连接数/时长有比 Hobby 的 300s 函数上限更宽松的模型，
  但 **CPU 时长**仍按请求算，纯转发代理开销很小。
- 存储：R2 免费 10GB/月，复刻样本是几 MB 级别，足够。
- 注意：WebSocket 在免费计划对**连接时长**有隐含限制，长对话重连逻辑（ws_chat 的
  replay）在 Workers 上更关键——这正好是仓库里已经做好的能力。

## 什么时候值得上 Cloudflare

- 你现在用 Render 免费版被 5GB/月带宽卡脖子，想换一家免费额度更宽松的。
- 你的域名已经托管在 CF，想省一层 DNS。
- 你其实只用到语音合成 + 复刻，实时对话可以牺牲。

## 什么时候别折腾

- 你三个实时页签都要。那值得先把 WebSocket 改写做完，或者干脆留在 Render/Vercel。
- 你不想碰 JS FFI / 平台专属代码。

---

## 参考

- https://developers.cloudflare.com/workers/languages/python/
- https://developers.cloudflare.com/workers/languages/python/packages/
- https://developers.cloudflare.com/workers/languages/python/stdlib/
- https://developers.cloudflare.com/workers/runtime-apis/websockets/
- https://developers.cloudflare.com/r2/api/workers/workers-api-usage/
- https://github.com/cloudflare/python-workers-examples（fastapi / websocket-stream-consumer）
