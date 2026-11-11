import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupFeedbackMedia } from '../../scripts/feedback-media-cleanup.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-222222222222';
const token = '33333333-3333-4333-8333-333333333333';
const claim = { id, token, bucket: 'feedback-media-images', staging_path: `staging/${owner}/${id}`, verified_path: `verified/${owner}/${id}` };

function fake({ claims = [claim], removalError = false, finishError = false } = {}) {
  const calls = [];
  return { calls, client: {
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'feedback_media_cleanup_claim') return { data: claims, error: null };
      if (args.p_success && finishError) return { data: null, error: new Error('lost response') };
      return { data: true, error: null };
    },
    storage: { from: (bucket) => ({ remove: async (paths) => { calls.push(['remove', bucket, paths]); return { error: removalError ? new Error('failure') : null }; } }) },
  } };
}

test('removes exactly both claimed objects and confirms only after successful deletion', async () => {
  const f = fake(); assert.deepEqual(await cleanupFeedbackMedia(f.client), { claimed: 1, cleaned: 1, retry: 0 });
  assert.deepEqual(f.calls.map((v) => v[0]), ['feedback_media_cleanup_claim', 'remove', 'feedback_media_cleanup_finish']);
  assert.deepEqual(f.calls[1].slice(1), [claim.bucket, [claim.staging_path, claim.verified_path]]);
  assert.equal(f.calls[2][1].p_success, true);
});
test('a deletion failure and an uncertain confirmation are recorded for retry', async () => {
  for (const options of [{ removalError: true }, { finishError: true }]) {
    const f = fake(options); assert.deepEqual(await cleanupFeedbackMedia(f.client), { claimed: 1, cleaned: 0, retry: 1 });
    assert.equal(f.calls.at(-1)[1].p_success, false);
  }
});
test('an invalid bucket or unrelated path is never passed to the storage API', async () => {
  for (const broken of [{ ...claim, bucket: 'submission-media' }, { ...claim, verified_path: `verified/${owner}/${token}` }, { ...claim, staging_path: `staging/${owner}/../../avatar` }]) {
    const f = fake({ claims: [broken] }); await assert.rejects(() => cleanupFeedbackMedia(f.client), /invalid cleanup claim/);
    assert.equal(f.calls.some((c) => c[0] === 'remove'), false);
  }
});
