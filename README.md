# 语音工坊 Speech Workbench

把[阿里云百炼语音示例](https://github.com/aliyun/alibabacloud-bailian-speech-demo)的核心能力整合成一个 Web 应用，补上声音复刻与音色管理，支持 Docker / Vercel / Render 部署。

所有录音和播放都在浏览器里完成，**API Key 只存在于服务端**。

![五个页签](https://img.shields.io/badge/tabs-5-6c8cff) ![Python](https://img.shields.io/badge/python-3.12-3572A5) ![License](https://img.shields.io/badge/license-MIT-blue) [![GHCR](https://img.shields.io/badge/image-ghcr.io/hbpc002/speech-workbench-2496ed)](https://github.com/hbpc002/speech-workbench/pkgs/container/speech-workbench)

**[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hbpc002/speech-workbench) [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/hbpc002/speech-workbench) [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new?repo=https://github.com/hbpc002/speech-workbench)**

---

## 功能

| 页签 | 能力 | 状态 |
|---|---|---|
| 实时语音对话 | 端到端语音对话，可打断，断线后自动恢复上下文 | ✅ 实测 |
| 实时语音识别 | 麦克风转字幕，流式增量 | ✅ 实测 |
| 语音合成 | **6 个模型 / 253 个音色**，语速音调音量可调，情感与场景指令，**情感标签**，历史记录 | ✅ 实测 |
| 声音复刻 | 录音或上传样本复刻音色，**样本自检 + 自动去静音**，生成带参数、指令与情感标签，历史记录 | 需公网 HTTPS |
| 短视频 | 口播稿 → **AI 拆场景** → 复刻音色配音 → Pexels 素材 + 字幕 + 音乐，服务端渲染成片，历史记录 | 需一体化镜像 |

### 声音复刻

- **样本自检**：时长 / 人声占比 / 峰值电平，提交前就告诉你样本能不能用
- **自动去除首尾静音**：阈值按这段录音自己的峰值算，录音音量小也不会误裁
- **上传自动转 16kHz 单声道**：mp3、立体声、48kHz 都能直接拖进来
- **生成带参数与指令**：语速 / 音调 / 音量 / 种子，情感、场景、方言、自定义
- **生成文本框**：6 行起、可拖高，带清空与撤销；标签 chip 插入也可撤销（和合成页同一套逻辑）
- **AI 加情感标签 / 快速标注 / AI 写口播稿**：和合成页共用同一个弹窗，结果落进生成文本框
- **生成记录**：播放 / 下载 WAV / 重新生成 / 删除，存 IndexedDB，刷新不丢
- **复刻记录**：记下每次的前缀、模型、样本时长和成败
- **音色管理**：本地改名与标签、可按标签筛选、直接显示上游审核状态与创建时间；生成音色下拉记住最近 5 个
- **列表本机缓存**：音色列表先从 IndexedDB 画出来再后台刷新，不用每次点「刷新列表」

复刻接口不管样本好坏都会返回成功，坏音色要等生成才发现。自检就是为了把这个反馈提前到提交之前 —— 音色配额有限，清理还是不可逆的。

### 短视频

- **AI 拆场景**：稿子按语义切成 1–2 句一场，同时给出 2–3 个英文 Pexels 检索词；模型不可用时退回按句拆分
- **复刻音色配音**：和语音合成页共用同一套 DashScope 音色，选哪个复刻音色就用哪个
- **画面**：Pexels 视频素材按检索词匹配，可选竖屏 9:16 / 横屏 16:9、字幕位置、背景音乐与音量
- **无人物素材**：Pexels 没有「不要人物」筛选项，所以先按 URL 标题过滤，再用本地 YOLOv8n 检查预览帧；检出人就换下一条，检索词也会要求 AI 避开人物
- **从语音记录直接开始**：语音合成 / 声音复刻的历史里点「生成视频」，会把这条记录**已经合成好的音频**带到短视频页签，不会再合成第二遍；字幕直接取口播稿（去掉情感标签），不用 Whisper 重识别
- **服务端渲染**：Remotion 在容器里渲染，不再占用浏览器；一条 15 秒成片约 1–3 分钟
- **记录**：播放 / 下载 / 删除，和渲染队列同一份数据

短视频需要 `Dockerfile.allinone` 那个一体化镜像（内含 short-video-maker 的 Node/Remotion 渲染器）。Vercel / Render 的纯 Python 部署没有渲染器，页签会自动置灰。

### 语音合成

- **253 个音色**分场景分组，带指令能力的音色在下拉里带角标
- **最近使用**：音色下拉最上面记住最近 5 个，省得每次从 12 组里翻
- **情感标签**（仅 qwen 系列）：`[excited]` `[whispers]` `[laughing]` `[cough]` … 共 30 个，直接写在文本里，且**跨句自动继承**
- **指令**：情感 / 场景 / 角色 / 身份 / 方言，qwen 系列还支持自由风格自然语言指令
- **历史记录**：每次生成新增一条，可按句重生成，下载时仍是完整音频；IndexedDB 持久化，刷新不丢

音色和模型强绑定，换模型必须同步换音色。完整的模型/音色/指令能力矩阵见 [`使用说明.md`](使用说明.md)。

---

## 快速开始

```bash
git clone <this-repo>
cd speech-workbench
python3 -m venv .venv && .venv/bin/pip install -e .

cp .env.example .env      # 填入 DASHSCOPE_API_KEY
.venv/bin/uvicorn server.main:app --port 8080
```

打开 http://localhost:8080

需要 [阿里云账号](https://help.aliyun.com/zh/account/user-guide/ali-cloud-account-registration-process)并开通[百炼模型服务](https://help.aliyun.com/zh/model-studio/getting-started/activate-alibaba-cloud-model-studio)（有免费额度），然后在[API-KEY 管理](https://help.aliyun.com/zh/model-studio/user-guide/api-key-management)创建密钥。

## 部署

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hbpc002/speech-workbench)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/hbpc002/speech-workbench)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new?repo=https://github.com/hbpc002/speech-workbench)

点按钮后填 `DASHSCOPE_API_KEY`，平台会自动读仓库里的 `render.yaml` / `vercel.json` 完成其余配置。声音复刻还要多填一个 `DASHSCOPE_WORKSPACE_ID`（`llm-xxxxxxxx`，百炼控制台「业务空间 → 业务空间详情」查）—— 百炼现在签发的 Key 都带 `sk-ws-` 前缀，复刻只认工作空间端点。

<details>
<summary>Docker / 自有服务器（含短视频渲染器）</summary>

```bash
# 用 CI 自动构建的镜像
docker pull ghcr.io/hbpc002/speech-workbench:latest

# 或本地构建（纯语音版，无短视频）
docker build -t speech-workbench .

docker run -p 8080:8080 -e DASHSCOPE_API_KEY=sk-xxx speech-workbench
```

短视频要一体化镜像：它把 short-video-maker 的 Node/Remotion 渲染器和本应用装进同一个容器，渲染器只监听回环地址，对外仍然只有一个端口。

```bash
docker build -f Dockerfile.allinone -t speech-workbench:allinone .

docker run -d --network host \
  -e DASHSCOPE_API_KEY=sk-xxx \
  -e DASHSCOPE_WORKSPACE_ID=llm-xxxxxxxx \
  -e PEXELS_API_KEY=xxxxxxxx \
  -e PUBLIC_BASE_URL=https://your-domain.tld \
  -v /srv/sw/videos:/app/data/videos \
  -v /srv/sw/whisper:/app/data/libs/whisper/models \
  speech-workbench:allinone
```

镜像默认 3123 对外、3125 给渲染器、8101 给回环 TTS 桥；`--network host` 下这三个端口都在宿主机上，其中只有 3123 应该被反代/发布出去。Pexels 素材缓存在 `/app/data`，Whisper 模型约 540MB，建议像上面一样挂出来，重建容器不用重新下载。

镜像随每次推送到 `main` 自动更新，多架构支持见 [`docs/技术说明.md`](docs/技术说明.md#自动构建镜像github-actions)。
</details>

> [!IMPORTANT]
> **声音复刻需要公网 HTTPS 地址**，且部署后要手动把 `PUBLIC_BASE_URL` 填成实际域名（如 `https://speech-workbench.onrender.com`）。不填的话四个页签里只有「声音复刻」会失败 —— 复刻接口要求阿里云从公网下载样本音频，`localhost` 拿不到。

部署细节（Render 免费版 5GB/月带宽、Vercel 区域选择等）见 [`docs/技术说明.md`](docs/技术说明.md#部署)。

---

## 文档

- [`使用说明.md`](使用说明.md) —— 完整操作手册，含常见问题
- [`口播稿提示词.md`](口播稿提示词.md) —— 可直接复制给 AI 的口播稿生成提示词
- [`docs/技术说明.md`](docs/技术说明.md) —— 部署、架构、自动构建、与上游示例的差异

---

## 与上游示例的关系

代码从 [aliyun/alibabacloud-bailian-speech-demo](https://github.com/aliyun/alibabacloud-bailian-speech-demo) 的示例改写而来，主要来源：

| 能力 | 上游路径 |
|---|---|
| 实时语音对话 | `samples/conversation/fun-audiochat-realtime/demo_app/web/` |
| 实时语音识别 | `samples/gallery/input-audio-out-text-html/python/server.py` |
| 语音合成 | `samples/gallery/cosyvoice-js/` |
| 声音复刻 | `samples/speech-synthesizer/synthesize_speech_from_text_with_cloned_voice/` |
| 录音 AudioWorklet | `samples/gallery/paraformer-realtime-js/recorder_worklet.js` |

做了这些改动：

- **所有音频 I/O 移到浏览器**。上游约 15 个示例依赖 `pyaudio` / `javax.sound.sampled` / `wxPython`，在无音频设备的容器里无法运行。
- **API Key 只在服务端**，浏览器拿不到（上游部分 JS 示例把 Key 拼在 URL 里）。
- **声音复刻免 OSS**：应用用自己的公网地址托管样本，不再需要手动上传 OSS 换 URL。
- **音色目录与指令能力表全部实测**，而非照抄官方文档 —— 官方表格有多处与实际不符（详见 `使用说明.md`）。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DASHSCOPE_API_KEY` | 必填 |
| `APP_PASSWORD` | 访问密码，留空关闭鉴权 |
| `SESSION_SECRET` | 签名会话 Cookie |
| `PUBLIC_BASE_URL` | 部署后的公网地址，`local` 存储（Render/Docker/本地）下声音复刻必填 |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob 读写 token。在 Vercel 上把 Blob store 通过 **Connect to Project** 连到项目后自动注入，无需手动添加 |
| `DASHSCOPE_WORKSPACE_ID` | `sk-ws-` 开头的业务空间 Key **必填**，否则声音复刻整页不可用（公共端点返回 `ModelNotFound`）。形如 `llm-xxxxxxxx`，百炼控制台「业务空间 → 业务空间详情」查 |
| `LLM_BASE_URL` | 文本模型端点，默认 `https://magpie.059618.xyz/v1`（magpie 网关） |
| `LLM_API_KEY` | magpie 的 Key，和 `DASHSCOPE_API_KEY` 是两把；不填则 AI 标注/写稿/拆场景不可用 |
| `LLM_MODELS` / `LLM_MODEL` | 模型 id，默认 `groq/openai/gpt-oss-120b`（Groq GPT-OSS-120B，经 magpie 转发）；备选 `groq/qwen/qwen3.8-27b`、`auto/qwen3.8-27b`、`group/never-stuck` |
| `PEXELS_API_KEY` | 短视频素材。Pexels 免费 Key 就够用 |
| `SVM_BASE_URL` | 渲染器地址，默认 `http://127.0.0.1:3125`；留空则短视频页签置灰 |
| `VIDEO_ENABLED` / `VIDEO_TTS_BRIDGE` | 一体化镜像里默认开；纯 Python 部署置灰 |
| `VIDEO_RENDERER_PORT` / `PUBLIC_PORT` | 渲染器 / 对外端口，默认 3125 / 3123 |

## License

MIT