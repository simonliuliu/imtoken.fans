// Remove only expired, unassociated feedback attachments claimed by 0035.
// No production call is made on import; explicit --apply is required to run.
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validClaim(item) {
  if (!item || !UUID.test(item.id) || !UUID.test(item.token)
      || !['feedback-media-images', 'feedback-media-videos'].includes(item.bucket)) return false;
  const match = /^staging\/([0-9a-f-]+)\/([0-9a-f-]+)$/i.exec(item.staging_path ?? '');
  return !!match && UUID.test(match[1]) && match[2] === item.id
    && item.verified_path === `verified/${match[1]}/${item.id}`;
}

export async function cleanupFeedbackMedia(client, limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid cleanup limit');
  const { data, error } = await client.rpc('feedback_media_cleanup_claim', { p_limit: limit });
  if (error || !Array.isArray(data)) throw new Error('cleanup claim failed');
  const result = { claimed: data.length, cleaned: 0, retry: 0 };
  for (const item of data) {
    if (!validClaim(item)) throw new Error('invalid cleanup claim');
    try {
      const removed = await client.storage.from(item.bucket).remove([item.staging_path, item.verified_path]);
      if (removed.error) throw new Error('storage deletion failed');
      const finished = await client.rpc('feedback_media_cleanup_finish', { p_id: item.id, p_token: item.token, p_success: true });
      if (finished.error || finished.data !== true) throw new Error('cleanup confirmation failed');
      result.cleaned += 1;
    } catch {
      // A lost response may have committed. An idempotent lease expiry/reclaim
      // handles uncertainty; never claim a failed removal as cleaned.
      try { await client.rpc('feedback_media_cleanup_finish', { p_id: item.id, p_token: item.token, p_success: false }); } catch { /* lease expiry permits a later retry */ }
      result.retry += 1;
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') {
    console.error('Usage: node scripts/feedback-media-cleanup.mjs --apply');
    process.exitCode = 2;
  } else if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Cleanup credentials are not configured.');
    process.exitCode = 2;
  } else {
    try {
      const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const result = await cleanupFeedbackMedia(client);
      console.log(JSON.stringify(result));
      if (result.retry) process.exitCode = 1;
    } catch {
      console.error('Feedback media cleanup failed; claimed items will be retried after their leases expire.');
      process.exitCode = 1;
    }
  }
}
