# 语音工坊 Speech Workbench

把[阿里云百炼语音示例](https://github.com/aliyun/alibabacloud-bailian-speech-demo)的核心能力整合成一个 Web 应用，补上声音复刻与音色管理，支持 Docker / Vercel / Render 部署。

所有录音和播放都在浏览器里完成，**API Key 只存在于服务端**。

![四个页签](https://img.shields.io/badge/tabs-4-6c8cff) ![Python](https://img.shields.io/badge/python-3.12-3572A5) ![License](https://img.shields.io/badge/license-MIT-blue) [![GHCR](https://img.shields.io/badge/image-ghcr.io/hbpc002/speech-workbench-2496ed)](https://github.com/hbpc002/speech-workbench/pkgs/container/speech-workbench)

**[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hbpc002/speech-workbench) [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/hbpc002/speech-workbench) [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new?repo=https://github.com/hbpc002/speech-workbench)**

---

## 功能

| 页签 | 能力 | 状态 |
|---|---|---|
| 实时语音对话 | 端到端语音对话，可打断，断线后自动恢复上下文 | ✅ 实测 |
| 实时语音识别 | 麦克风转字幕，流式增量 | ✅ 实测 |
| 语音合成 | **6 个模型 / 253 个音色**，语速音调音量可调，情感与场景指令，**情感标签**，历史记录 | ✅ 实测 |
| 声音复刻 | 录音或上传样本复刻音色，**样本自检 + 自动去静音**，生成带参数、指令与情感标签，历史记录 | 需公网 HTTPS |

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
<summary>Docker / 自有服务器</summary>

```bash
# 用 CI 自动构建的镜像
docker pull ghcr.io/hbpc002/speech-workbench:latest

# 或本地构建
docker build -t speech-workbench .

docker run -p 8080:8080 -e DASHSCOPE_API_KEY=sk-xxx speech-workbench
```

镜像随每次推送到 `main` 自动更新，多架构支持见 [`docs/技术说明.md`](docs/技术说明.md#自动构建镜像github-actions)。
</details>

> [!IMPORTANT]
> **声音复刻需要公网 HTTPS 地址**，且部署后要手动把 `PUBLIC_BASE_URL` 填成实际域名（如 `https://speech-workbench.onrender.com`）。不填的话四个页签里只有「声音复刻」会失败 —— 复刻接口要求阿里云从公网下载样本音频，`localhost` 拿不到。

部署细节（Render 免费版 5GB/月带宽、Vercel 区域选择等）见 [`docs/技术说明.md`](docs/技术说明.md#部署)。

想在 **Cloudflare Workers** 上跑？可行，但需要一次 WebSocket 层改写，可行性分析与脚手架见 [`docs/部署到 Cloudflare.md`](docs/部署到%20Cloudflare.md) 和 [`cloudflare/`](cloudflare/)。

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
| `LLM_MODELS` / `LLM_MODEL` | AI 标注/写稿的模型。百炼 Key 带模型白名单，不在名单里报 403 `AccessDenied` 而非 404；默认的两个是实测调得通的 |

## License

MIT