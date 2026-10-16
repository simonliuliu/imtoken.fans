/** Actual ProductFeedbackForm handlers with deterministic hooks and real draft storage.
 * No credentials, network, real accounts or database writes. Run with node. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = (path) => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const compiled = compile('../../src/components/product-feedback-form.tsx');
const draftCode = compile('../../src/lib/feedback-drafts.ts');
const KIND = 'product-feedback-v2';
const draftKey = (owner, kind = KIND) => `imtoken-feedback-draft:${owner ?? 'anonymous'}:${kind}`;
function host({ store = new Map(), owner = 'owner-a', locale = 'zh', resume = false, responses = [], storageFails = false, now = Date.now(), posts = [], searchFails = false, viewer = owner } = {}) {
  let slots = [], cursor = 0, effects = [], tree, id = 0;
  const timers = new Map(), calls = [], navigation = [], events = [], translations = new Map();
  const state = { storageFails, uuidFails: false };
  const storage = { getItem(key) { if (state.storageFails) throw Error('disabled'); return store.get(key) ?? null; }, setItem(key, value) { if (state.storageFails) throw Error('disabled'); store.set(key, value); }, removeItem(key) { if (state.storageFails) throw Error('disabled'); store.delete(key); } };
  const drafts = {};
  vm.runInNewContext(draftCode, { exports: drafts, sessionStorage: storage, Date: { now: () => now } });
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const hooks = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (v) => { slots[i].value = typeof v === 'function' ? v(slots[i].value) : v; }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useId() { return `id-${cursor++}`; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const modules = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'next-intl': { useLocale: () => locale, useTranslations(ns) { if (!translations.has(ns)) translations.set(ns, (key, args) => `${locale}:${ns}.${key}${args ? JSON.stringify(args) : ''}`); return translations.get(ns); } },
    'next/navigation': { useSearchParams: () => new URLSearchParams(resume ? 'resume=1' : '') },
    '@/components/auth-loading': { AuthLoading: 'loading' },
    '@/lib/auth-context': { useAuth: () => ({ user: owner ? { id: owner } : null, loading: false, sessionEpoch: 0 }) },
    '@/lib/auth-navigation': { getSignInHref: () => '/sign-in?resume=1' },
    '@/lib/feedback-drafts': drafts,
    '@/i18n/navigation': { Link: 'a', useRouter: () => ({ push: (href) => navigation.push(href) }) },
    '@/app/actions/feedback': { async writeFeedback(action, payload) { calls.push({ action, payload }); const r = responses.shift(); if (r instanceof Error) throw r; return typeof r === 'function' ? r() : r; }, async readFeedback() { if (searchFails) throw Error('offline'); return { ok: true, data: { posts, viewer: { user_id: viewer } } }; } },
    '@/lib/feedback': { FEEDBACK_MODULES: ['wallet', 'transfer', 'browser', 'other'], FEEDBACK_CHANGED: 'feedback-changed' },
    './community-compose.module.css': { submitError: 'error' },
  };
  const exports = {};
  const setTimer = (fn) => { timers.set(++id, fn); return id; };
  vm.runInNewContext(compiled, { exports, require: (name) => { assert(name in modules, name); return modules[name]; }, URLSearchParams,
    crypto: { randomUUID() { if (state.uuidFails) throw Error('uuid'); return `11111111-1111-1111-1111-${String(++id).padStart(12, '0')}`; } },
    window: { setTimeout: setTimer, clearTimeout: (id) => timers.delete(id), dispatchEvent: (e) => events.push(e) },
    setTimeout: setTimer, clearTimeout: (id) => timers.delete(id), CustomEvent: class { constructor(type) { this.type = type; } },
  });
  function walk(n, visit) { if (Array.isArray(n)) return n.forEach((i) => walk(i, visit)); if (!n || typeof n !== 'object' || !n.props) return; visit(n); walk(n.props.children, visit); }
  function render() { cursor = 0; effects = []; const outer = exports.ProductFeedbackForm(); tree = outer.type(outer.props); walk(tree, (n) => { if (n.props.ref) n.props.ref.current = { focus() {}, scrollIntoView() {} }; }); effects.forEach((f) => f()); }
  const all = (predicate) => { const a = []; walk(tree, (n) => { if (predicate(n)) a.push(n); }); return a; };
  const find = (p) => { const n = all(p)[0]; assert(n, 'expected element'); return n; };
  const text = (n) => Array.isArray(n) ? n.map(text).join('') : n && typeof n === 'object' ? text(n.props?.children) : n == null || typeof n === 'boolean' ? '' : String(n);
  function edit(type, value, index = 0) { all((n) => n.type === type)[index].props.onChange({ target: { value } }); render(); }
  render();
  async function tick() { const ts = [...timers.values()]; timers.clear(); for (const fn of ts) await fn(); render(); }
  return { store, state, drafts, calls, navigation, events, render, tick, all, find, text, edit,
    async init() { await tick(); return this; },
    fill() { edit('input', 'Feedback title'); edit('textarea', 'Detailed reproducible issue'); },
    submit: () => find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} }),
    get title() { return find((n) => n.type === 'input').props.value; },
    get locked() { return find((n) => n.type === 'input').props.disabled; },
    get content() { return text(tree); },
    unmount() { slots.forEach((s) => s?.cleanup?.()); },
  };
}
let passed = 0;
async function test(name, fn) { await fn(); console.log(`PASS ${name}`); passed++; }
const fail = { ok: false, code: 'request_failed', error: 'Unknown result' };
const ok = { ok: true, data: { id: 'published' } };
await test('edits synchronously save all fields before navigation, refresh and locale restore', async () => {
  const h = await host().init(); h.fill(); h.edit('input', '3.2.0', 1); h.edit('select', 'ios', 1);
  const raw = JSON.parse(h.store.get(draftKey('owner-a'))); assert.equal(raw.value.form.details.device, 'ios');
  for (const locale of ['zh', 'en']) { const restored = await host({ store: h.store, locale }).init(); assert.equal(restored.title, 'Feedback title'); assert.equal(restored.all((n) => n.type === 'input')[1].props.value, '3.2.0'); }
});
await test('similar link return restores persistent draft; legacy Composer cannot consume it', async () => {
  const h = await host({ posts: [{ id: 'similar', title: 'Similar feedback' }] }).init(); h.fill(); await h.tick();
  assert(h.all((n) => n.type === 'a').some((n) => h.text(n) === 'Similar feedback'));
  assert.equal(h.drafts.takeFeedbackDraft('idea', 'owner-a'), null);
  h.unmount(); const returned = await host({ store: h.store }).init(); assert.equal(returned.title, 'Feedback title');
});
await test('anonymous draft only claims with explicit resume and never crosses accounts', async () => {
  const anonymous = await host({ owner: null }).init(); anonymous.fill();
  const normal = await host({ store: anonymous.store }).init(); assert.equal(normal.title, '');
  const resumed = await host({ store: anonymous.store, resume: true }).init(); assert.equal(resumed.title, 'Feedback title'); assert(!anonymous.store.has(draftKey(null)));
  const other = await host({ store: anonymous.store, owner: 'owner-b', resume: true }).init(); assert.equal(other.title, '');
});
await test('30 minute expiry and future timestamp discard draft', async () => {
  const h = await host().init(); h.fill();
  const expired = await host({ store: new Map(h.store), now: Date.now() + 31 * 60 * 1000 }).init(); assert.equal(expired.title, '');
  const future = await host({ store: h.store, now: Date.now() - 60000 }).init(); assert.equal(future.title, '');
});
await test('corrupt and unavailable storage show warning; unavailable persistence never sends', async () => {
  const corrupt = await host({ store: new Map([[draftKey('owner-a'), '{broken']]) }).init(); assert(corrupt.content.includes('persistentDraftUnavailable'));
  const h = await host({ storageFails: true }).init(); h.fill(); await h.submit(); h.render(); assert.equal(h.calls.length, 0); assert(h.content.includes('persistentDraftUnavailable'));
});
await test('unknown result locks original payload against edits and locale switching retry', async () => {
  const h = await host({ responses: [fail] }).init(); h.fill(); await h.submit(); h.render(); assert(h.locked); assert(h.content.includes('pendingRetry'));
  h.edit('input', 'Changed title'); assert.equal(h.title, 'Feedback title');
  const retry = await host({ store: h.store, locale: 'en', responses: [ok] }).init(); assert(retry.locked); await retry.submit(); retry.render();
  assert.deepEqual(JSON.parse(JSON.stringify(retry.calls[0].payload)), JSON.parse(JSON.stringify(h.calls[0].payload)));
  assert(h.calls[0].payload.description.startsWith('zh:')); assert.equal(retry.navigation.length, 1); assert(!h.store.has(draftKey('owner-a')));
  await retry.submit(); assert.equal(retry.calls.length, 1); assert(!h.store.has(draftKey('owner-a')));
});
await test('transport throw and malformed success keep immutable persisted request', async () => {
  for (const response of [Error('offline'), { ok: true, data: {} }]) {
    const h = await host({ responses: [response] }).init(); h.fill(); await h.submit(); h.render(); assert(h.locked); assert.equal(h.navigation.length, 0); assert(JSON.parse(h.store.get(draftKey('owner-a'))).value.pending.id);
  }
});
await test('definitive rejection unlocks edits and next changed payload gets new UUID', async () => {
  const h = await host({ responses: [{ ok: false, code: 'invalid', error: 'Invalid' }, ok] }).init(); h.fill(); await h.submit(); h.render(); assert(!h.locked); h.edit('input', 'Updated feedback'); await h.submit(); assert.notEqual(h.calls[0].payload.id, h.calls[1].payload.id); assert.equal(h.calls[1].payload.title, 'Updated feedback');
});
await test('double clicks stay single request and owner-unmount blocks stale success', async () => {
  let release; const gate = new Promise((r) => { release = r; }); const h = await host({ responses: [() => gate] }).init(); h.fill(); const first = h.submit(); await h.submit(); assert.equal(h.calls.length, 1); h.unmount(); release(ok); await first; assert.equal(h.navigation.length, 0); assert.equal(h.events.length, 0); assert(h.store.has(draftKey('owner-a')));
  const other = await host({ store: h.store, owner: 'owner-b' }).init(); assert.equal(other.title, ''); assert(!other.locked);
});
await test('legacy UUID is never silently reused with reconstructed or changed payload', async () => {
  const h = host({ resume: true }); h.drafts.saveFeedbackDraft('idea', 'owner-a', { title: 'Old draft', body: 'Old body', module: 'wallet', requestId: '11111111-1111-1111-1111-111111111111' }); await h.init(); assert.equal(h.title, 'Old draft'); assert(h.locked); assert(h.content.includes('legacyPending')); await h.submit(); assert.equal(h.calls.length, 0); assert(h.all((n) => n.type === 'a').some((n) => n.props.href.includes('idea=11111111')));
});
await test('anonymous login keeps draft and sends no action', async () => {
  const h = await host({ owner: null }).init(); h.fill(); await h.submit(); assert.equal(h.calls.length, 0); assert.equal(h.navigation.length, 1); assert(h.store.has(draftKey(null)));
});
await test('whitespace and total description over limit cannot send', async () => {
  const h = await host().init(); h.fill(); h.edit('textarea', '   '); await h.submit(); assert.equal(h.calls.length, 0);
  h.edit('textarea', 'x'.repeat(5000)); await h.submit(); h.render(); assert.equal(h.calls.length, 0); assert(h.content.includes('descriptionTooLong'));
});
await test('search failure and stale viewer results never replace form', async () => {
  for (const options of [{ searchFails: true }, { viewer: 'wrong-account', posts: [{ id: 'wrong', title: 'Do not show' }] }]) { const h = await host(options).init(); h.fill(); await h.tick(); assert.equal(h.title, 'Feedback title'); assert(!h.content.includes('Do not show')); }
});
await test('UUID failure is visible, leaves editor usable, sends nothing', async () => {
  const h = await host().init(); h.fill(); h.state.uuidFails = true; await h.submit(); h.render(); assert.equal(h.calls.length, 0); assert(!h.locked); assert(h.content.includes('unexpected'));
});
await test('unknown outcome followed by sign-in rejection must not release original UUID', async () => {
  const h = await host({ responses: [fail, { ok: false, code: 'sign_in', error: 'Sign in again' }] }).init(); h.fill(); await h.submit(); h.render(); await h.submit(); h.render(); assert(h.locked);
  const saved = JSON.parse(h.store.get(draftKey('owner-a'))).value; assert.equal(saved.pending.id, h.calls[0].payload.id);
  const remount = await host({ store: h.store, responses: [ok] }).init(); await remount.submit(); assert.equal(remount.calls[0].payload.id, h.calls[0].payload.id);
});
await test('first-attempt expired session keeps editable owner draft for sign-in', async () => {
  const h = await host({ responses: [{ ok: false, code: 'sign_in', error: 'Sign in again' }] }).init(); h.fill(); await h.submit(); h.render(); assert(!h.locked); await h.submit(); assert.equal(h.calls.length, 1); assert(h.navigation[0].includes('sign-in'));
});
await test('suggestion fields persist; original serialized suggestion survives translated retry', async () => {
  const h = await host({ responses: [fail] }).init();
  h.find((n) => n.type === 'button' && h.text(n).includes('communitySubmit.suggestionType')).props.onClick(); h.render(); h.fill(); h.edit('textarea', 'Useful proposal', 2); await h.submit();
  const retry = await host({ store: h.store, locale: 'en', responses: [ok] }).init(); assert.equal(retry.all((n) => n.type === 'textarea')[2].props.value, 'Useful proposal'); await retry.submit(); assert.equal(retry.calls[0].payload.description, h.calls[0].payload.description); assert(retry.calls[0].payload.description.includes('Useful proposal'));
});
await test('conflict keeps snapshot locked and offers original feedback link', async () => {
  const h = await host({ responses: [{ ok: false, code: 'conflict', error: 'Conflict' }] }).init(); h.fill(); await h.submit(); h.render(); assert(h.locked); assert(h.all((n) => n.type === 'a').some((n) => n.props.href.includes(`idea=${h.calls[0].payload.id}`)));
});
await test('forged owner envelope is rejected without disclosing its contents', async () => {
  const store = new Map([[draftKey('owner-b'), JSON.stringify({ owner: 'owner-a', createdAt: Date.now(), value: { form: { title: 'Private owner A title', body: 'private', module: 'wallet', kind: 'bug', details: {} }, pending: null } })]]);
  const h = await host({ store, owner: 'owner-b' }).init(); assert.equal(h.title, ''); assert(!h.content.includes('Private owner A')); assert(h.content.includes('persistentDraftUnavailable'));
});
await test('ordinary restore never renews expiry; editing renews only the edited owner draft', async () => {
  const started = Date.now(); const h = await host({ now: started }).init(); h.fill();
  const before = h.store.get(draftKey('owner-a'));
  await host({ store: h.store, now: started + 20 * 60 * 1000 }).init(); assert.equal(h.store.get(draftKey('owner-a')), before);
  await host({ store: h.store, owner: 'owner-b', now: started + 25 * 60 * 1000 }).init(); assert.equal(h.store.get(draftKey('owner-a')), before);
  const expired = await host({ store: h.store, now: started + 31 * 60 * 1000 }).init(); assert.equal(expired.title, '');
  const edited = await host({ now: started }).init(); edited.fill();
  const later = await host({ store: edited.store, now: started + 20 * 60 * 1000 }).init(); later.edit('input', 'Edited at minute 20');
  const retained = await host({ store: edited.store, now: started + 31 * 60 * 1000 }).init(); assert.equal(retained.title, 'Edited at minute 20');
});
await test('unconfirmed pending survives past 30 minutes and retries only its original payload', async () => {
  const started = Date.now(); const h = await host({ now: started, responses: [fail] }).init(); h.fill(); await h.submit();
  const before = h.store.get(draftKey('owner-a'));
  const later = await host({ store: h.store, now: started + 7 * 24 * 60 * 60 * 1000, responses: [ok] }).init(); assert(later.locked); assert.equal(h.store.get(draftKey('owner-a')), before);
  await later.submit(); assert.deepEqual(JSON.parse(JSON.stringify(later.calls[0].payload)), JSON.parse(JSON.stringify(h.calls[0].payload))); assert(!h.store.has(draftKey('owner-a')));
});
await test('expired legacy request UUID migrates without erasure and remains blocked after 30 minutes', async () => {
  const started = Date.now(); const h = host({ now: started }); h.drafts.saveFeedbackDraft('idea', 'owner-a', { title: 'Old pending', body: 'Old body', module: 'wallet', requestId: '11111111-1111-1111-1111-111111111111' });
  const migrated = await host({ store: h.store, resume: true, now: started + 60 * 60 * 1000 }).init(); assert(migrated.locked); assert.equal(migrated.title, 'Old pending');
  const later = await host({ store: h.store, now: started + 7 * 24 * 60 * 60 * 1000 }).init(); assert(later.locked); assert(later.content.includes('legacyPending')); await later.submit(); assert.equal(later.calls.length, 0);
});
await test('legacy explicit original-ID retry succeeds when old request never committed', async () => {
  const h = host({ resume: true, responses: [ok] }); const id = '11111111-1111-1111-1111-111111111111';
  h.drafts.saveFeedbackDraft('idea', 'owner-a', { title: 'Old unsaved', body: 'Old body', module: 'wallet', requestId: id }); await h.init();
  await h.find((n) => n.type === 'button' && h.text(n).includes('retryLegacy')).props.onClick({ preventDefault() {} }); h.render(); assert.equal(h.calls[0].payload.id, id); assert.equal(h.navigation.length, 1); assert(!h.store.has(draftKey('owner-a')));
});
await test('legacy existing request with different serialization conflicts without new UUID', async () => {
  const h = host({ resume: true, responses: [{ ok: false, code: 'conflict', error: 'Different saved content' }, fail] }); const id = '11111111-1111-1111-1111-111111111111';
  h.drafts.saveFeedbackDraft('idea', 'owner-a', { title: 'Old saved', body: 'Old body', module: 'wallet', requestId: id }); await h.init();
  await h.find((n) => n.type === 'button' && h.text(n).includes('retryLegacy')).props.onClick({ preventDefault() {} }); h.render(); assert(h.locked); assert.equal(h.navigation.length, 0); assert.equal(h.calls[0].payload.id, id);
  await h.submit(); assert.equal(h.calls[1].payload.id, id); assert.equal(h.calls[0].payload.description, h.calls[1].payload.description);
});
await test('initial read failure blocks overwriting prior pending until explicit reload succeeds', async () => {
  const h = await host({ responses: [fail] }).init(); h.fill(); await h.submit(); const before = h.store.get(draftKey('owner-a'));
  const failed = await host({ store: h.store, storageFails: true, responses: [ok] }).init(); assert(failed.locked); failed.edit('input', 'Replacement title'); assert.equal(failed.title, '');
  failed.state.storageFails = false; failed.edit('input', 'Replacement after recovery'); await failed.submit(); assert.equal(failed.calls.length, 0); assert.equal(h.store.get(draftKey('owner-a')), before);
  failed.find((n) => n.type === 'button' && failed.text(n).includes('reloadDraft')).props.onClick(); failed.render(); await failed.tick(); assert.equal(failed.title, 'Feedback title'); assert(failed.locked);
  await failed.submit(); assert.equal(failed.calls[0].payload.id, h.calls[0].payload.id);
});
await test('corrupt draft recovery requires explicit reload before editing is enabled', async () => {
  const h = await host({ store: new Map([[draftKey('owner-a'), '{broken']]) }).init(); assert(h.locked); h.fill(); assert.equal(h.title, '');
  h.find((n) => n.type === 'button' && h.text(n).includes('reloadDraft')).props.onClick(); h.render(); await h.tick(); assert(!h.locked); h.fill(); assert.equal(h.title, 'Feedback title');
});
console.log(`${passed} ProductFeedbackForm regression cases passed (actual handlers, mocked services).`);
