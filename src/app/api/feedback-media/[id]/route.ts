import { createClient } from "@/lib/supabase/server";
import { FEEDBACK_MEDIA_TYPES } from "@/lib/feedback-media-limits.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGE = /^bytes=(?:\d{1,12}-\d{0,12}|-\d{1,12})$/;
function empty(status: number, extra: Record<string, string> = {}) {
  return new Response(null, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", ...extra } });
}

/** Every request rechecks feedback and media visibility; no signed URL is returned. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id: rawId } = await context.params;
    if (typeof rawId !== "string" || !UUID.test(rawId)) return empty(404);
    const id = rawId.toLowerCase();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("feedback_media_object", { p_id: id });
    if (error || !data || data.id !== id || typeof data.type !== "string" || !Object.hasOwn(FEEDBACK_MEDIA_TYPES, data.type)
        || !Number.isSafeInteger(data.size) || data.size <= 0 || data.size > FEEDBACK_MEDIA_TYPES[data.type as keyof typeof FEEDBACK_MEDIA_TYPES]) return empty(404);
    const expectedBucket = data.type.startsWith("image/") ? "feedback-media-images" : "feedback-media-videos";
    const parts = typeof data.path === "string" ? data.path.split("/") : [];
    if (data.bucket !== expectedBucket || parts.length !== 3 || parts[0] !== "verified" || !UUID.test(parts[1]) || parts[2] !== id) return empty(404);
    const range = request.headers.get("range");
    if (range && !RANGE.test(range)) return empty(416, { "Content-Range": `bytes */${data.size}` });
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) return empty(503);
    const endpoint = new URL(`/storage/v1/object/authenticated/${data.bucket}/${parts.map(encodeURIComponent).join("/")}`, base);
    const headers = new Headers({ apikey: key, authorization: `Bearer ${key}` });
    if (range) headers.set("range", range);
    const upstream = await fetch(endpoint, { method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(120000)]) });
    if (upstream.status === 416) return empty(416, { "Content-Range": `bytes */${data.size}` });
    if (![200, 206].includes(upstream.status) || !upstream.body || upstream.status === 206 && !upstream.headers.get("content-range")) return empty(502);
    const responseHeaders = new Headers({ "Content-Type": data.type, "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Accept-Ranges": "bytes" });
    for (const name of ["content-length", "content-range"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return empty(503);
  }
}
