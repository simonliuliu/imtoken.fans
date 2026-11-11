import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const id = '33333333-3333-4333-8333-333333333333';
const owner = '11111111-1111-4111-8111-111111111111';
const metadata = { id, bucket: 'feedback-media-videos', path: `verified/${owner}/${id}`, type: 'video/mp4', size: 4 };
function host(options = {}) {
  const calls = [];
  const imports = {
    '@/lib/supabase/server': { createClient: async () => ({ rpc: async (name, args) => { calls.push(['rpc', name, args]); return { data: options.data ?? metadata, error: options.error ?? null }; } }) },
    '@/lib/feedback-media-limits.mjs': { FEEDBACK_MEDIA_TYPES: { 'image/png': 5242880, 'video/mp4': 31457280 } },
  };
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../../src/app/api/feedback-media/[id]/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports: testModule.exports, module: testModule, Request, Response, Headers, URL, AbortSignal,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fictional-service-key' } },
    fetch: async (url, init) => { calls.push(['fetch', url.toString(), init]); return options.upstream ?? new Response(Uint8Array.from([1, 2]), { status: 206, headers: { 'content-range': 'bytes 0-1/4', 'content-length': '2' } }); },
    require(name) { assert(name in imports, name); return imports[name]; },
  });
  return { ...testModule.exports, calls };
}
const context = { params: Promise.resolve({ id }) };
test('authorized byte ranges are streamed without exposing the service key or a signed URL', async () => {
  const h = host(); const response = await h.GET(new Request('https://site.invalid/api/media', { headers: { range: 'bytes=0-1' } }), context);
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 0-1/4');
  assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [1, 2]);
  assert.equal(response.headers.has('location'), false);
  const fetched = h.calls.find((c) => c[0] === 'fetch'); assert.equal(fetched[2].headers.get('range'), 'bytes=0-1'); assert.equal(fetched[2].redirect, 'error');
});
test('denied RPCs and unrelated paths never reach privileged storage', async () => {
  for (const options of [{ error: { message: 'feedback_media_not_found' } }, { data: { ...metadata, bucket: 'submission-media' } }, { data: { ...metadata, path: `verified/${owner}/../../other` } }, { data: { ...metadata, type: 'text/html' } }]) {
    const h = host(options); const response = await h.GET(new Request('https://site.invalid/api/media'), context);
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(h.calls.some((c) => c[0] === 'fetch'), false);
  }
});
test('multi-range requests are rejected and malformed partial upstream responses fail closed', async () => {
  const h = host(); const bad = await h.GET(new Request('https://site.invalid/api/media', { headers: { range: 'bytes=0-1,3-4' } }), context);
  assert.equal(bad.status, 416); assert.equal(h.calls.some((c) => c[0] === 'fetch'), false);
  const incomplete = host({ upstream: new Response(Uint8Array.from([1]), { status: 206 }) });
  const failed = await incomplete.GET(new Request('https://site.invalid/api/media'), context);
  assert.equal(failed.status, 502); assert.equal(failed.headers.get('cache-control'), 'private, no-store');
});
