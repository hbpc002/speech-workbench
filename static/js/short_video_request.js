// "用这条语音生成短视频" —— 历史记录和短视频页签之间唯一的连接点。
//
// 两个页签互相 import 会形成环（tab_video 已经 import 了 app.js，而 app.js 在
// 启动时动态 import 所有页签）。所以走一个 DOM 事件：这里只负责发，tab_video
// 负责接。它没有 import 任何会碰 document 的模块，所以可以在 node --test 里跑。

export const SHORT_VIDEO_EVENT = 'short-video:prefill';

/**
 * Ask the short-video tab to take over with this record.
 *
 * `model` and `voice` are optional. When both are present the tab selects
 * `model:voice` — that is how a preset voice (or a cloned one) survives the
 * trip: the renderer re-synthesises the text, and without the model the bridge
 * cannot tell `longanhuan@cosyvoice-v2` from `longanhuan@cosyvoice-v3-flash`.
 */
export function requestShortVideo({ text, model, voice, sentences, sampleRate } = {}) {
  const body = String(text || '').trim();
  if (!body) return false;
  // Only finished sentences with samples are useful; a record that was never
  // synthesised falls back to the text path in the video tab.
  const audio = (Array.isArray(sentences) ? sentences : [])
    .map((sentence) => ({
      text: String(sentence?.text || ''),
      pcm: sentence?.pcm || null,
    }))
    .filter((sentence) => sentence.text && sentence.pcm && sentence.pcm.length);
  const detail = {
    text: body,
    model: String(model || ''),
    voice: String(voice || ''),
    sentences: audio,
    sampleRate: Number(sampleRate) || 0,
  };
  window.dispatchEvent(new CustomEvent(SHORT_VIDEO_EVENT, { detail }));
  return true;
}
