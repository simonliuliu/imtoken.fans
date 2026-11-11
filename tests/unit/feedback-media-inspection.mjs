import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { BlobSource, Input, MP4 } from 'mediabunny';
import { inspectFeedbackMedia } from '../../src/lib/feedback-media-inspect.mjs';

let directory, png, jpeg, mp4, tooLong, audioOnly, corrupt, falseDimensions, decoderPath;
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'feedback-media-test-'));
  decoderPath = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
  png = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#2468ac' } }).png().toBuffer();
  jpeg = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#ab6824' } }).jpeg().toBuffer();
  for (const [file, duration] of [['short.mp4', 2], ['long.mp4', 121]]) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:size=16x16:rate=1', '-t', String(duration), '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-an', path.join(directory, file)]);
  }
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', path.join(directory, 'audio.mp4')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:size=4096x2304:rate=1', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-an', path.join(directory, 'wide.mp4')]);
  [mp4, tooLong, audioOnly] = await Promise.all(['short.mp4', 'long.mp4', 'audio.mp4'].map((name) => readFile(path.join(directory, name))));
  corrupt = Buffer.from(mp4);
  for (let offset = 0; offset + 8 <= corrupt.length;) {
    let size = corrupt.readUInt32BE(offset);
    if (size === 1) size = Number(corrupt.readBigUInt64BE(offset + 8));
    if (!size) size = corrupt.length - offset;
    if (corrupt.toString('ascii', offset + 4, offset + 8) === 'mdat') corrupt.fill(0, offset + 8, offset + size);
    offset += size;
  }
  falseDimensions = await readFile(path.join(directory, 'wide.mp4'));
  const sampleEntry = falseDimensions.lastIndexOf(Buffer.from('avc1'));
  assert(sampleEntry >= 0);
  falseDimensions.writeUInt16BE(16, sampleEntry + 28);
  falseDimensions.writeUInt16BE(16, sampleEntry + 30);
  const misleading = new Input({ source: new BlobSource(new Blob([falseDimensions])), formats: [MP4] });
  const track = await misleading.getPrimaryVideoTrack();
  assert.equal(await track.getDisplayWidth(), 16);
  assert.equal(await track.getDisplayHeight(), 16);
  misleading.dispose();
  await writeFile(path.join(directory, 'spoofed.mp4'), falseDimensions);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(directory, 'spoofed.mp4')], { encoding: 'utf8' });
  assert.equal(probe.trim(), '4096,2304');
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('a decoded image returns exact bytes, dimensions and digest', async () => {
  const result = await inspectFeedbackMedia(png, 'image/png', png.length);
  assert.deepEqual(result, { ok: true, type: 'image/png', width: 16, height: 12, duration: null, sha256: createHash('sha256').update(png).digest('hex'), size: png.length });
  assert.equal((await inspectFeedbackMedia(jpeg, 'image/jpeg', jpeg.length)).ok, true);
});
test('declared type, declared size, corrupt bytes and unsupported types fail closed', async () => {
  for (const [bytes, type, size] of [[jpeg, 'image/png', jpeg.length], [png, 'image/png', png.length + 1], [Buffer.from('not an image'), 'image/png', 12], [png, 'text/html', png.length], [png, '__proto__', png.length], [png, 'video/mp4', png.length]]) {
    assert.equal((await inspectFeedbackMedia(bytes, type, size)).ok, false);
  }
});
test('real H.264 MP4 is inspected for video stream, time and digest', async () => {
  const result = await inspectFeedbackMedia(mp4, 'video/mp4', mp4.length, { decoderPath });
  assert.equal(result.ok, true);
  assert.equal(result.duration, 2);
  assert.equal(result.width, null);
  assert.equal(result.sha256, createHash('sha256').update(mp4).digest('hex'));
});
test('longer videos, audio-only files and a wrong container are rejected', async () => {
  for (const [bytes, type] of [[tooLong, 'video/mp4'], [audioOnly, 'video/mp4'], [mp4, 'video/webm']]) {
    assert.equal((await inspectFeedbackMedia(bytes, type, bytes.length, { decoderPath })).ok, false);
  }
});
test('damaged video packets and forged small container dimensions fail real bounded decoding', async () => {
  for (const bytes of [corrupt, falseDimensions]) assert.equal((await inspectFeedbackMedia(bytes, 'video/mp4', bytes.length, { decoderPath })).ok, false);
});
test('video is never accepted without a configured trusted decoder', async () => {
  assert.deepEqual(await inspectFeedbackMedia(mp4, 'video/mp4', mp4.length, { decoderPath: '' }), { ok: false, code: 'decoder_unavailable' });
});
test('inspection timeout fails closed', async () => {
  assert.deepEqual(await inspectFeedbackMedia(mp4, 'video/mp4', mp4.length, { timeoutMs: 1, decoderPath }), { ok: false, code: 'inspection_timeout' });
});
