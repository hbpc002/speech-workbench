# 部署到 Cloudflare Workers（脚手架）

这是「语音工坊」的 Cloudflare Workers 部署脚手架。**它只打通了 REST + 静态页面
+ R2 声音复刻存储**；三个 WebSocket 实时端点（/ws/chat、/ws/asr、/ws/tts）
**尚未移植**，详见仓库根的 [docs/部署到 Cloudflare.md](../docs/部署到%20Cloudflare.md)，
那里解释了为什么、以及需要怎么改。

> 一句话结论：**能部署，但不是开箱即用**。如果你只需要语音合成 + 声音复刻，
> 当前的 Render/Vercel 已经是最省事的路。选 Cloudflare 主要是为了它免费版更宽松、
> 以及域名托管在 CF。要继续，请先看完可行性文档再动手。

## 前提

- 装好 [uv](https://docs.astral.sh/uv/getting-started/installation/)
- 装好 Node（wrangler 依赖它）
- 一个 Cloudflare 账号

## 建 R2 bucket

```bash
npx wrangler r2 bucket create speech-workbench-media
```

给 bucket 一个公网地址：**强烈建议绑自定义域**（R2 → your bucket → Settings →
Custom Domain），比如 `media.example.com`。也可以临时用 r2.dev 的 Public bucket
（R2 → your bucket → Settings → Public access → Enable），但 r2.dev 域名带随机前缀。

把该公网地址填进 `wrangler.toml` 的 `R2_PUBLIC_BUCKET_URL`（不带尾部斜杠）。

## 设置密钥

```bash
npx wrangler secret put DASHSCOPE_API_KEY
npx wrangler secret put DASHSCOPE_WORKSPACE_ID
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET
```

## 本地跑

```bash
cd cloudflare
uv sync
uv run pywrangler dev
```

## 部署

```bash
cd cloudflare
uv run pywrangler deploy
```

## 当前能用的 / 不能用的

| 能力 | 状态 |
|---|---|
| 静态页面 + REST（/api/*、/healthz、登录鉴权） | ✅ 应可直接工作 |
| 声音复刻（R2 存储 + 上传样本） | ✅ 存储侧已就绪 |
| 实时语音对话 / 识别 / 合成（/ws/*） | ❌ 需 WebSocket 改写 |
