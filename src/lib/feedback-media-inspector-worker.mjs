// Runs untrusted media parsing in a short-lived, resource-limited worker.
// No URLs, credentials, filesystem paths, or user-provided commands are read.
import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import { BlobSource, EncodedPacketSink, Input, MP4, WEBM } from "mediabunny";
import { FEEDBACK_VIDEO_MAX_SECONDS } from "./feedback-media-limits.mjs";

const IMAGE_FORMATS = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" };
const VIDEO_CODECS = { "video/mp4": new Set(["avc"]), "video/webm": new Set(["vp8", "vp9", "av1"]) };
const AUDIO_CODECS = { "video/mp4": new Set(["aac"]), "video/webm": new Set(["opus", "vorbis"]) };
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_VIDEO_PIXELS = 4096 * 2160;

async function inspectImage(bytes, declaredType) {
  const source = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, animated: true });
  const info = await source.metadata();
  if (info.format !== IMAGE_FORMATS[declaredType] || !info.width || !info.height) throw new Error("invalid_format");
  if (info.width * info.height > MAX_IMAGE_PIXELS) throw new Error("invalid_dimensions");
  // stats forces libvips to decode the data instead of accepting only a header.
  await source.stats();
  return { type: declaredType, width: info.width, height: info.height, duration: null };
}

async function inspectVideo(bytes, declaredType) {
  const input = new Input({ source: new BlobSource(new Blob([bytes])), formats: [MP4, WEBM] });
  try {
    const format = await input.getFormat();
    if (format !== (declaredType === "video/mp4" ? MP4 : WEBM)) throw new Error("invalid_format");
    const tracks = await input.getTracks();
    const videoTracks = tracks.filter((track) => track.type === "video");
    const audioTracks = tracks.filter((track) => track.type === "audio");
    if (tracks.length > 3 || videoTracks.length !== 1 || audioTracks.length > 1 || tracks.length !== videoTracks.length + audioTracks.length) throw new Error("invalid_tracks");
    const video = videoTracks[0];
    if (!VIDEO_CODECS[declaredType].has(await video.getCodec())) throw new Error("invalid_codec");
    if (audioTracks.length && !AUDIO_CODECS[declaredType].has(await audioTracks[0].getCodec())) throw new Error("invalid_codec");
    const width = await video.getDisplayWidth();
    const height = await video.getDisplayHeight();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > MAX_VIDEO_PIXELS) throw new Error("invalid_dimensions");
    const duration = await input.computeDuration(undefined, { skipLiveWait: true });
    const first = await input.getFirstTimestamp();
    if (!Number.isFinite(duration) || !Number.isFinite(first) || first < 0 || duration <= first || duration > FEEDBACK_VIDEO_MAX_SECONDS) throw new Error("invalid_duration");
    for (const track of tracks) {
      const sink = new EncodedPacketSink(track);
      if (!await sink.getFirstPacket({ skipLiveWait: true }) || !await sink.getPacket(Infinity, { skipLiveWait: true })) throw new Error("invalid_packets");
    }
    return { type: declaredType, width, height, duration };
  } finally {
    input.dispose();
  }
}

try {
  const bytes = Buffer.from(workerData.bytes);
  const result = workerData.type.startsWith("image/")
    ? await inspectImage(bytes, workerData.type)
    : await inspectVideo(bytes, workerData.type);
  parentPort.postMessage({ ok: true, result });
} catch {
  // The caller receives only a stable failure code, never parser internals.
  parentPort.postMessage({ ok: false, code: "invalid_media" });
}
