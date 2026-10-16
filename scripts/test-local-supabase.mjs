import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');
assert(
  url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) &&
  url.port === '54321' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash,
  'This smoke test only accepts the local Supabase at http://127.0.0.1:54321.',
);
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(anonKey && serviceKey, 'Configure both local Supabase keys in .env.local first.');
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(url.href, serviceKey, options);
const anonymous = createClient(url.href, anonKey, options);
const users = [];
const posts = [];
const files = [];
const checks = [];

function success(result, label) {
  assert.ifError(result.error && new Error(`${label}: ${result.error.message}`));
  return result.data;
}
async function check(label, run) {
  await run();
  checks.push(label);
  console.log(`PASS ${label}`);
}
async function account(suffix) {
  const username = `local_${randomBytes(5).toString('hex')}_${suffix}`;
  const email = `${username}@example.test`;
  const password = randomBytes(24).toString('base64url');
  const { user } = success(await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { username, display_name: `Local smoke test ${suffix}` },
  }), 'create local test account');
  users.push(user.id);
  const client = createClient(url.href, anonKey, options);
  success(await client.auth.signInWithPassword({ email, password }), 'password login');
  return { id: user.id, client };
}

try {
  await check('Auth health endpoint responds', async () => {
    const response = await fetch(new URL('/auth/v1/health', url), { headers: { apikey: anonKey }, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
  });
  const author = await account('a');
  const reader = await account('b');
  await check('Two independent password sessions and profile triggers work', async () => {
    for (const actor of [author, reader]) {
      const profile = success(await actor.client.from('profiles').select('id,username,role').eq('id', actor.id).single(), 'read own profile');
      assert.equal(profile.id, actor.id);
      assert.equal(profile.role, 'user');
    }
  });
  const request = {
    p_expected: author.id, p_request: randomUUID(), p_section: 'discussion', p_category: 'questions',
    p_title: 'Local Supabase smoke test', p_body: 'This local-only test verifies real persistence and account isolation.',
  };
  let postId;
  await check('Community RPC persists a pending post and makes retries idempotent', async () => {
    postId = success(await author.client.rpc('community_post_create', request), 'create pending post');
    posts.push(postId);
    assert.equal(success(await author.client.rpc('community_post_create', request), 'retry same post'), postId);
    const rows = success(await author.client.from('submissions').select('id,status').eq('id', postId), 'author reads pending post');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
  });
  await check('RLS hides pending posts from another account and anonymous readers', async () => {
    for (const client of [reader.client, anonymous]) {
      assert.deepEqual(success(await client.from('submissions').select('id').eq('id', postId), 'read pending post'), []);
    }
  });
  await check('Anonymous writes and account impersonation are rejected', async () => {
    assert((await anonymous.rpc('community_post_create', { ...request, p_request: randomUUID() })).error);
    assert((await reader.client.rpc('community_post_create', { ...request, p_request: randomUUID() })).error);
    const result = await reader.client.from('profiles').update({ role: 'admin' }).eq('id', reader.id);
    assert(result.error, 'An ordinary user must not grant themselves admin.');
    const profile = success(await admin.from('profiles').select('role').eq('id', reader.id).single(), 'confirm role');
    assert.equal(profile.role, 'user');
  });
  await check('Feedback table revocations survive migration replay while the read RPC works', async () => {
    for (const client of [anonymous, reader.client]) {
      assert((await client.from('feedback_posts').select('id').limit(1)).error, 'Raw feedback tables must stay private.');
      const result = success(await client.rpc('feedback_read'), 'read feedback through public projection');
      assert(Array.isArray(result.posts));
    }
  });
  await check('A privileged moderation decision makes the persisted post visible across accounts', async () => {
    const rows = success(await admin.from('submissions').update({ status: 'published' }).eq('id', postId).select('id'), 'publish local test post');
    assert.equal(rows.length, 1);
    for (const client of [reader.client, anonymous]) {
      const post = success(await client.from('submission_cards').select('id,title').eq('id', postId).single(), 'read published post');
      assert.equal(post.id, postId);
    }
  });
  await check('Another account can persist a like through the real RPC', async () => {
    assert.equal(success(await reader.client.rpc('community_like_write', { p_expected: reader.id, p_submission: postId, p_liked: true }), 'like post'), true);
    const likes = success(await anonymous.from('community_likes').select('user_id').eq('submission_id', postId), 'read persisted like');
    assert.equal(likes.length, 1);
    assert.equal(likes[0].user_id, reader.id);
  });
  await check('Comment RPC respects the actual moderation configuration', async () => {
    const comment = success(await reader.client.rpc('community_comment_create', {
      p_expected: reader.id, p_request: randomUUID(), p_submission: postId,
      p_body: 'A real comment written through the local Supabase API.',
    }), 'create local comment');
    const setting = success(await admin.from('moderation_settings').select('mode').eq('target_type', 'comment').single(), 'read moderation mode');
    assert.equal(comment.status, setting.mode === 'none' ? 'published' : 'pending');
    const persisted = success(await admin.from('comments').select('id,body').eq('id', comment.id).single(), 'read persisted comment');
    assert.equal(persisted.id, comment.id);
  });
  const bucket = 'submission-media';
  const objectPath = `${author.id}/local-smoke-${randomUUID()}.png`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDRsAAAAASUVORK5CYII=', 'base64');
  await check('Storage bucket exists and accepts an authenticated owner upload', async () => {
    const info = success(await admin.storage.getBucket(bucket), 'read media bucket');
    assert.equal(info.public, true);
    success(await author.client.storage.from(bucket).upload(objectPath, png, { contentType: 'image/png' }), 'upload local test PNG');
    files.push(objectPath);
    const publicUrl = author.client.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
    const response = await fetch(publicUrl, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  });
  await check('Storage rejects anonymous uploads and another account using the owner folder', async () => {
    for (const client of [anonymous, reader.client]) {
      const path = `${author.id}/local-denied-${randomUUID()}.png`;
      const result = await client.storage.from(bucket).upload(path, png, { contentType: 'image/png' });
      if (!result.error) files.push(path);
      assert(result.error, 'Upload unexpectedly bypassed the owner-folder policy.');
    }
  });
} finally {
  // Remove only records created by this run; keep migration seeds and manual test accounts.
  const failures = [];
  async function clean(label, promise) {
    const result = await promise;
    if (result.error) failures.push(`${label}: ${result.error.message}`);
  }
  if (files.length) await clean('test uploads', admin.storage.from('submission-media').remove(files));
  if (posts.length) {
    const eventKeys = posts.map(id => `submissions:${id}`);
    await clean('test moderation entries', admin.from('moderation_queue').delete().in('target_id', posts));
    const comments = await admin.from('comments').select('id').in('submission_id', posts);
    if (comments.error) failures.push(`list test comments: ${comments.error.message}`);
    else if (comments.data.length) {
      const commentIds = comments.data.map(row => row.id);
      eventKeys.push(...commentIds.map(id => `comments:${id}`));
      await clean('comment moderation entries', admin.from('moderation_queue').delete().in('target_id', commentIds));
    }
    await clean('test posts', admin.from('submissions').delete().in('id', posts));
    // The event ledger has no cascading FK. Preserve all events belonging to other content.
    await clean('test notification events', admin.from('notification_events').delete().in('event_key', eventKeys));
    const remaining = await admin.from('notification_events').select('event_key').in('event_key', eventKeys);
    if (remaining.error) failures.push(`verify event cleanup: ${remaining.error.message}`);
    else if (remaining.data.length) failures.push('Notification events from this run remain.');
  }
  for (const id of users) await clean('test account', admin.auth.admin.deleteUser(id));
  assert.deepEqual(failures, [], 'Local smoke cleanup failed.');
  console.log('PASS Temporary accounts, posts, uploads and notification events cleaned up');
}
console.log(`Local Supabase smoke test passed: ${checks.length} checks.`);
