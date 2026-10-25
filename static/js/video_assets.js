// Background assets (image / video / music) for the video renderer.
//
// Where these are stored is the interesting decision, so it is stated once,
// here:
//
//   * IndexedDB, in this browser, never uploaded. Vercel's function filesystem
//     is read-only outside /tmp and its instances are not sticky, so a server
//     copy would need object storage (Vercel Blob is already wired up for voice
//     enrollment samples, server/storage.py). That is the right answer for
//     assets that must survive a device change or be shared by a team, and the
//     wrong answer for this feature: a background image is a decoration the
//     operator picks per export, and routing it through a shared bucket would
//     make one person's holiday photo the whole team's dropdown.
//
//   * A `Blob`, not a base64 string. Base64 inflates by a third and the whole
//     string lives in memory; a structured-clone of a Blob lets the browser
//     spool it to disk. This is the same reasoning that keeps PCM out of
//     localStorage -- see the note on DB_VERSION in audio.js.
//
//   * One store, no per-record copies. A rendered record references an asset by
//     id, so deleting an asset cannot orphan bytes inside a hundred records.
//
// Quota is real: browsers give an origin a few GB at most, and video is big. The
// upload path therefore rejects anything over `MAX_ASSET_BYTES` and the dialog
// shows the running total instead of letting the operator discover the limit by
// hitting a `QuotaExceededError` mid-upload.

import { tx } from './db.js';

const STORE = 'video-assets';

/** 40 MB. A 1080p loop of a few seconds is single-digit MB; a raw phone clip is not. */
export const MAX_ASSET_BYTES = 40 * 1024 * 1024;

/** What an asset is used for. Kept separate from the MIME type, which is a guess. */
export const ASSET_KINDS = [
  { id: 'image', label: '背景图片', accept: 'image/*' },
  { id: 'video', label: '背景视频', accept: 'video/*' },
  { id: 'music', label: '背景音乐', accept: 'audio/*' },
];

/** Accept-string for an `<input type="file">`, per kind. */
export function acceptFor(kind) {
  return ASSET_KINDS.find((entry) => entry.id === kind)?.accept || '';
}

/**
 * Classify a file by its declared type, falling back to the extension.
 *
 * `file.type` is empty for some `.mp3` files on Windows and can be a lie in
 * general, so the extension is a real second signal, not a nicety.
 */
export function kindOfFile(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'music';

  const name = String(file?.name || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp)$/.test(name)) return 'image';
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(name)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(name)) return 'music';
  return '';
}

/**
 * Validate a candidate upload before it is stored.
 *
 * Returns a message on rejection, or null when it is acceptable. Separated from
 * the storage code so the rules can be tested without a browser, and so the
 * dialog can show the same message the store would enforce.
 */
export function rejectionFor(file, { usedBytes = 0 } = {}) {
  if (!file) return '没有选择文件。';
  const kind = kindOfFile(file);
  if (!kind) return '这个文件类型不支持，请选择图片、视频或音频。';
  if (!file.size) return '这个文件是空的。';
  if (file.size > MAX_ASSET_BYTES) {
    return `文件太大（${formatBytes(file.size)}），上限 ${formatBytes(MAX_ASSET_BYTES)}。`;
  }
  if (usedBytes + file.size > MAX_ASSET_BYTES * 4) {
    // The per-file cap alone does not stop the origin from filling up, and a
    // quota error arrives as an unhelpful DOMException mid-write.
    return `素材总占用会超过 ${formatBytes(MAX_ASSET_BYTES * 4)}，先删掉一些再上传。`;
  }
  return null;
}

/** `12.3 MB` for a byte count, at a precision that stays useful at both ends. */
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * How to fit a source rect into a destination rect without distortion.
 *
 * `cover` for both images and video backgrounds: the frame must be filled, and
 * letterboxing a background looks like a bug. The overflow is cropped, which is
 * the standard behaviour of `object-fit: cover` and what a photo taken in the
 * wrong orientation needs.
 */
export function coverRect(sourceWidth, sourceHeight, width, height) {
  if (!sourceWidth || !sourceHeight) return { x: 0, y: 0, width, height };
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  return {
    x: (width - drawWidth) / 2,
    y: (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  };
}

/** Total bytes held in the store, for the dialog's usage line. */
export function totalBytes(assets) {
  return (assets || []).reduce((sum, asset) => sum + (Number(asset?.bytes) || 0), 0);
}

// ---- storage ---------------------------------------------------------------
//
// Deliberately thin: the rules above are pure, and this is the only part that
// needs a browser. Keeping the split means the tests never have to fake
// IndexedDB.

/** Newest first, so the picker opens on what was just added. */
export function loadAssets() {
  return tx(STORE, 'readonly', (store) => store.getAll()).then((rows) =>
    (rows || [])
      .map((row) => ({ ...row, url: URL.createObjectURL(row.blob) }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  );
}

/** Store one file. `id` is generated here so the caller gets a stable handle. */
export function saveAsset(file, kind = kindOfFile(file)) {
  const id = `asset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    kind: kind || 'image',
    name: String(file.name || '未命名'),
    type: String(file.type || ''),
    bytes: Number(file.size) || 0,
    createdAt: Date.now(),
    blob: file,
  };
  return tx(STORE, 'readwrite', (store) => store.put(record)).then(() => record);
}

export function deleteAsset(id) {
  return tx(STORE, 'readwrite', (store) => store.delete(id));
}

export function clearAssets() {
  return tx(STORE, 'readwrite', (store) => store.clear());
}
