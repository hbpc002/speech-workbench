// Background-asset rules: classification, limits, and the cover fit.
//
// The storage half of video_assets.js needs a browser, but everything that
// decides "is this file acceptable" and "where does it go on the frame" is
// pure, and those are the parts that produce a bad export when they are wrong.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ASSET_KINDS,
  MAX_ASSET_BYTES,
  acceptFor,
  coverRect,
  formatBytes,
  kindOfFile,
  rejectionFor,
  totalBytes,
} from '../../static/js/video_assets.js';

/** A `File`-shaped object; the rules only read name, type and size. */
const file = (name, type, size) => ({ name, type, size });

describe('kindOfFile', () => {
  it('classifies by declared MIME type', () => {
    assert.equal(kindOfFile(file('a.png', 'image/png', 10)), 'image');
    assert.equal(kindOfFile(file('a.mp4', 'video/mp4', 10)), 'video');
    assert.equal(kindOfFile(file('a.mp3', 'audio/mpeg', 10)), 'music');
  });

  it('falls back to the extension when the type is empty', () => {
    // Windows reports an empty type for some .mp3 files, which is why the
    // extension is a real second signal rather than belt-and-braces.
    assert.equal(kindOfFile(file('song.mp3', '', 10)), 'music');
    assert.equal(kindOfFile(file('clip.MOV', '', 10)), 'video');
    assert.equal(kindOfFile(file('photo.JPEG', '', 10)), 'image');
  });

  it('trusts the type when it and the extension disagree', () => {
    // A `.mp4` that the OS knows is really audio should be offered as music.
    assert.equal(kindOfFile(file('actually-audio.mp4', 'audio/mp4', 10)), 'music');
  });

  it('rejects anything it cannot place', () => {
    assert.equal(kindOfFile(file('notes.txt', 'text/plain', 10)), '');
    assert.equal(kindOfFile(file('archive.zip', '', 10)), '');
    assert.equal(kindOfFile(null), '');
  });
});

describe('acceptFor', () => {
  it('gives each kind an accept string', () => {
    assert.equal(acceptFor('image'), 'image/*');
    assert.equal(acceptFor('video'), 'video/*');
    assert.equal(acceptFor('music'), 'audio/*');
  });

  it('gives an unknown kind nothing, so the picker does not offer everything', () => {
    assert.equal(acceptFor('nope'), '');
  });

  it('covers every declared kind', () => {
    for (const kind of ASSET_KINDS) assert.ok(acceptFor(kind.id));
  });
});

describe('rejectionFor', () => {
  it('accepts a normal file', () => {
    assert.equal(rejectionFor(file('a.jpg', 'image/jpeg', 2 * 1024 * 1024)), null);
  });

  it('rejects a missing file', () => {
    assert.match(rejectionFor(null), /没有选择/);
  });

  it('rejects an unsupported type', () => {
    assert.match(rejectionFor(file('a.txt', 'text/plain', 10)), /不支持/);
  });

  it('rejects an empty file', () => {
    // A 0-byte pick means the "save" was really a cancel on some platforms, and
    // storing it gives a background that never decodes.
    assert.match(rejectionFor(file('a.png', 'image/png', 0)), /空的/);
  });

  it('rejects a file over the per-file cap and says how big it is', () => {
    const message = rejectionFor(file('big.mp4', 'video/mp4', MAX_ASSET_BYTES + 1));
    assert.match(message, /太大/);
    assert.match(message, /MB/);
  });

  it('accepts a file exactly at the cap', () => {
    assert.equal(rejectionFor(file('edge.mp4', 'video/mp4', MAX_ASSET_BYTES)), null);
  });

  it('rejects an upload that would fill the store', () => {
    const nearlyFull = MAX_ASSET_BYTES * 4 - 1024;
    assert.match(rejectionFor(file('a.jpg', 'image/jpeg', 4096), { usedBytes: nearlyFull }), /总占用/);
  });

  it('lets a small upload through when the store has room', () => {
    assert.equal(rejectionFor(file('a.jpg', 'image/jpeg', 4096), { usedBytes: 1024 }), null);
  });
});

describe('formatBytes', () => {
  it('uses the unit that keeps the number readable', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
    assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB');
  });

  it('never renders a negative or NaN size', () => {
    assert.equal(formatBytes(-5), '0 B');
    assert.equal(formatBytes(undefined), '0 B');
    assert.equal(formatBytes('nope'), '0 B');
  });
});

describe('coverRect', () => {
  it('fills a wide frame from a square source without distorting it', () => {
    const rect = coverRect(100, 100, 1280, 720);
    // Scale driven by width; height overflows and is cropped evenly.
    assert.equal(rect.width, 1280);
    assert.equal(rect.height, 1280);
    assert.equal(rect.x, 0);
    assert.equal(rect.y, (720 - 1280) / 2);
  });

  it('fills a tall frame from a wide source', () => {
    const rect = coverRect(1920, 1080, 720, 1280);
    assert.equal(rect.height, 1280);
    assert.equal(rect.width, 1920 * (1280 / 1080));
    assert.ok(rect.x < 0, 'should overflow horizontally');
  });

  it('leaves an exact match untouched', () => {
    assert.deepEqual(coverRect(1280, 720, 1280, 720), { x: 0, y: 0, width: 1280, height: 720 });
  });

  it('crops symmetrically, so the subject stays centred', () => {
    const rect = coverRect(100, 100, 1000, 500);
    assert.equal(rect.x, 0);
    assert.equal(rect.y + rect.height, 500 - rect.y);
  });

  it('degrades to filling the frame when the source size is unknown', () => {
    // A video element reports 0x0 before metadata loads; returning NaN here
    // would make drawImage silently draw nothing.
    assert.deepEqual(coverRect(0, 0, 640, 360), { x: 0, y: 0, width: 640, height: 360 });
  });
});

describe('totalBytes', () => {
  it('sums the assets', () => {
    assert.equal(totalBytes([{ bytes: 100 }, { bytes: 250 }]), 350);
  });

  it('treats a missing size as zero', () => {
    assert.equal(totalBytes([{ bytes: 100 }, {}, { bytes: null }]), 100);
  });

  it('handles an empty list', () => {
    assert.equal(totalBytes([]), 0);
    assert.equal(totalBytes(null), 0);
  });
});
