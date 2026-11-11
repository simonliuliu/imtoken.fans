// This policy is mirrored by migration 0035. The verifier checks the real
// bytes again; browser MIME and size checks are only an early convenience.
export const FEEDBACK_MEDIA_TYPES = Object.freeze({
  "image/png": 5 * 1024 * 1024,
  "image/jpeg": 5 * 1024 * 1024,
  "image/webp": 5 * 1024 * 1024,
  "image/gif": 5 * 1024 * 1024,
  "video/mp4": 30 * 1024 * 1024,
  "video/webm": 30 * 1024 * 1024,
});
export const FEEDBACK_VIDEO_MAX_SECONDS = 120;
export const FEEDBACK_MEDIA_MAX_IMAGES = 5;
export const FEEDBACK_MEDIA_MAX_VIDEOS = 1;
