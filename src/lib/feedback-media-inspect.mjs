import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { FEEDBACK_MEDIA_TYPES } from "./feedback-media-limits.mjs";

const execFileAsync = promisify(execFile);

async function decodeVideo(bytes, type, decoderPath, timeoutMs) {
  if (!decoderPath || !path.isAbsolute(decoderPath)) return { ok: false, code: "decoder_unavailable" };
  if (timeoutMs <= 0) return { ok: false, code: "inspection_timeout" };
  let directory;
  try {
    directory = await mkdtemp(path.join(tmpdir(), "imtoken-media-"));
    const input = path.join(directory, "input");
    await writeFile(input, bytes, { flag: "wx", mode: 0o600 });
    const format = type === "video/mp4" ? ["-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0"] : ["-f", "matroska"];
    await execFileAsync(decoderPath, ["-hide_banner", "-loglevel", "error", "-xerror", "-nostdin", "-max_alloc", "67108864",
      "-protocol_whitelist", "file,pipe", ...format, "-max_pixels", "8847360", "-threads", "1", "-i", input,
      "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], {
      timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 65536,
      env: { PATH: "/usr/bin:/bin", LANG: "C", TMPDIR: directory },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code === "ENOENT" ? "decoder_unavailable" : error?.killed || error?.signal === "SIGKILL" ? "inspection_timeout" : "invalid_media" };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** Inspect real bytes in an isolated worker. Call only from a trusted server. */
export async function inspectFeedbackMedia(bytes, declaredType, declaredSize, options = {}) {
  const max = typeof declaredType === "string" && Object.hasOwn(FEEDBACK_MEDIA_TYPES, declaredType) ? FEEDBACK_MEDIA_TYPES[declaredType] : 0;
  if (!(bytes instanceof Uint8Array) || !max || !Number.isSafeInteger(declaredSize)
      || declaredSize <= 0 || declaredSize > max || bytes.byteLength !== declaredSize) {
    return { ok: false, code: "invalid_media" };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 8000, 8000));
  const deadline = Date.now() + timeoutMs;
  // Transfer a copy, not the caller's buffer; the trusted service needs those
  // exact bytes to populate the immutable verified object after inspection.
  const copy = Uint8Array.from(bytes);
  const preliminary = await new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(new URL("./feedback-media-inspector-worker.mjs", import.meta.url), {
      workerData: { bytes: copy, type: declaredType },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "inspection_timeout" }), timeoutMs);
    worker.once("message", (message) => finish(message?.ok ? { ok: true, ...message.result, sha256: digest, size: declaredSize } : { ok: false, code: "invalid_media" }));
    worker.once("error", () => finish({ ok: false, code: "inspection_failed" }));
    worker.once("exit", () => finish({ ok: false, code: "inspection_failed" }));
  });
  if (!preliminary.ok || !declaredType.startsWith("video/")) return preliminary;
  // Container dimensions are untrusted. Decode every stream with an actual
  // pixel cap; do not report the container's possibly forged dimensions.
  const decoded = await decodeVideo(bytes, declaredType, options.decoderPath ?? process.env.FEEDBACK_MEDIA_DECODER_BIN, deadline - Date.now());
  return decoded.ok ? { ...preliminary, width: null, height: null } : decoded;
}
