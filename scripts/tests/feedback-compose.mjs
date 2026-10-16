/**
 * Executes the actual Composer component and its event/effect handlers with a small
 * deterministic hook host. All Server Actions/router/browser APIs are mocked:
 * no network, credentials, database, real accounts or new dependencies are used.
 * Layout/viewport visibility is separately checked in the browser.
 * Run: node scripts/tests/feedback-compose.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../src/components/community-elements.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function host({ responses = [], uuidThrows = false, searchThrows = false } = {}) {
  let slots = [], cursor = 0, effects = [], tree, nextTimer = 0;
  const timers = new Map(), elements = new Map(), translations = new Map();
  const calls = [], navigation = [], events = [], focus = [], scroll = [], clearedDrafts = [];
  let uuidCalls = 0;
  const state = { searchThrows, uuidThrows, reads: 0 };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const hooks = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (next) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useId() { const i = cursor++; slots[i] ??= `id-${i}`; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++; const old = slots[i]; if (!old || deps?.some((value, index) => value !== old.deps?.[index])) { slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
  };
  const modules = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol.for('fragment') },
    'next-intl': { useTranslations(namespace) { if (!translations.has(namespace)) translations.set(namespace, (key) => `${namespace}.${key}`); return translations.get(namespace); } },
    '@/lib/auth-context': { useAuth: () => ({ user: { id: 'current-account' }, loading: false, sessionEpoch: 0 }) },
    '@/lib/feedback-drafts': { saveFeedbackDraft() {}, takeFeedbackDraft() { return null; }, clearFeedbackDraft(...args) { clearedDrafts.push(args); } },
    '@/i18n/navigation': { Link: 'a', useRouter: () => ({ push: (href) => navigation.push(href) }) },
    '@/app/actions/feedback': {
      async writeFeedback(action, payload) { calls.push({ action, payload: { ...payload } }); const result = responses.shift(); if (result instanceof Error) throw result; return typeof result === 'function' ? result() : result; },
      async readFeedback() { state.reads++; if (state.searchThrows) throw Error('search unavailable'); return { ok: true, data: { posts: [], viewer: { user_id: 'current-account' } } }; },
    },
    '@/lib/feedback': { FEEDBACK_MODULES: ['wallet', 'transfer', 'browser', 'other'], FEEDBACK_CHANGED: 'feedback-changed', FEEDBACK_COMPOSE: 'feedback-compose' },
    '@/lib/community-demo': { COMMUNITY_SECTIONS: ['safety', 'feedback', 'discussion', 'activities'], SECTION_CATEGORIES: { safety: ['guides'], feedback: ['wallet', 'builds', 'changelog'], discussion: ['questions'], activities: ['community'] } },
    './community-compose.module.css': { submitError: 'submit-error' },
  };
  const exports = {};
  const context = vm.createContext({
    exports, require(name) { assert(name in modules, `Unexpected component dependency: ${name}`); return modules[name]; },
    crypto: { randomUUID() { uuidCalls++; if (state.uuidThrows) throw Error('UUID unavailable'); return 'idempotent-request-id'; } },
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent: (event) => events.push(event), location: { search: '' } },
    URLSearchParams, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(compiled, context, { filename: 'community-elements.tsx' });
  function walk(node, visit, parent = null) { if (Array.isArray(node)) { node.forEach((item) => walk(item, visit, parent)); return; } if (!node || typeof node !== 'object' || !('props' in node)) return; visit(node, parent); walk(node.props.children, visit, node); }
  function render() {
    cursor = 0; effects = [];
    const wrapper = exports.ComposeDemoButton({ section: 'feedback' });
    tree = wrapper.type(wrapper.props);
    walk(tree, (node) => { if (node.props.ref && typeof node.props.ref === 'object') { const ref = node.props.ref; if (!elements.has(ref)) elements.set(ref, { focus() { focus.push(node.props.role ?? node.type); }, scrollIntoView(options) { scroll.push(options); }, showModal() {}, close() { events.push({ type: 'dialog-close' }); } }); ref.current = elements.get(ref); } });
    effects.forEach((effect) => effect());
    return tree;
  }
  function find(predicate) { let result; walk(tree, (node, parent) => { if (!result && predicate(node)) result = { node, parent }; }); assert(result, 'Expected component element'); return result; }
  function findAll(predicate) { const result = []; walk(tree, (node) => { if (predicate(node)) result.push(node); }); return result; }
  function text(node) { if (Array.isArray(node)) return node.map(text).join(''); if (node == null || typeof node === 'boolean') return ''; return typeof node === 'object' ? text(node.props?.children) : String(node); }
  function fill() { find((node) => node.type === 'input').node.props.onChange({ target: { value: 'Real user title' } }); render(); find((node) => node.type === 'textarea').node.props.onChange({ target: { value: 'The real user description must survive failures.' } }); render(); }
  function form() { return find((node) => node.type === 'form').node; }
  function submit() { return form().props.onSubmit({ preventDefault() {} }); }
  function assertRetained() { assert.equal(find((node) => node.type === 'input').node.props.value, 'Real user title'); assert.equal(find((node) => node.type === 'textarea').node.props.value, 'The real user description must survive failures.'); }
  function assertFailure(message) {
    render(); const { node: alert, parent } = find((node) => node.props.role === 'alert');
    assert.equal(parent.type, 'form', 'Publishing error must live beside form submit, not above the long form');
    assert(text(alert).includes(message)); assert.equal(findAll((node) => node.props.role === 'alert').length, 1);
    assert.equal(find((node) => node.props.type === 'submit').node.props['aria-describedby'], alert.props.id);
    assert.equal(alert.props.tabIndex, -1); assert.equal(focus.at(-1), 'alert'); assert.equal(scroll.at(-1).block, 'nearest');
    assert.equal(find((node) => node.props.type === 'submit').node.props.disabled, false); assertRetained();
  }
  render(); fill();
  return { render, find, findAll, text, submit, assertFailure, assertRetained, calls, navigation, events, state, clearedDrafts, get uuidCalls() { return uuidCalls; }, async runTimers() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) await callback(); render(); }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
await test('returned login failure is near submit, focused, keeps fields, and provides login handoff', async () => {
  const h = host({ responses: [{ ok: false, code: 'sign_in', error: 'Please sign in to save this IDEA.' }] });
  await h.submit(); h.assertFailure('Please sign in');
  const alert = h.find((node) => node.props.role === 'alert').node;
  assert(h.text(alert).includes('feedbackLive.signInContinue'));
  assert.equal(h.calls.length, 1); assert.equal(h.navigation.length, 0); assert.equal(h.events.length, 0);
});
await test('empty returned errors fall back to a nonempty visible failure', async () => {
  const h = host({ responses: [{ ok: false, code: 'request_failed', error: '   ' }] }); await h.submit(); h.assertFailure('feedbackLive.unexpected');
});
await test('Action throw restores submit and preserves inputs for a manual retry', async () => {
  const h = host({ responses: [Error('transport failed')] }); await h.submit(); h.assertFailure('feedbackLive.unexpected'); assert.equal(h.calls.length, 1);
});
await test('UUID throw is caught and finally restores submit; retry can proceed', async () => {
  const h = host({ uuidThrows: true, responses: [{ ok: false, code: 'configuration', error: 'Not configured' }] });
  await h.submit(); h.assertFailure('feedbackLive.unexpected'); assert.equal(h.calls.length, 0);
  h.state.uuidThrows = false; await h.submit(); h.assertFailure('Not configured'); assert.equal(h.calls.length, 1);
});
await test('failure then manual success retains idempotency UUID and clears inputs only on confirmed success', async () => {
  const h = host({ responses: [{ ok: false, code: 'request_failed', error: 'Retry manually' }, { ok: true, data: { id: 'saved-post' } }] });
  await h.submit(); h.assertFailure('Retry manually'); await h.submit(); h.render();
  assert.equal(h.calls.length, 2); assert.equal(h.uuidCalls, 1); assert.equal(h.calls[0].payload.id, h.calls[1].payload.id);
  assert.equal(h.calls[1].payload.title, 'Real user title'); assert.equal(h.calls[1].payload.expected_user_id, 'current-account');
  assert.equal(h.find((node) => node.type === 'input').node.props.value, ''); assert.equal(h.find((node) => node.type === 'textarea').node.props.value, '');
  assert.equal(h.navigation.length, 1); assert(h.navigation[0].includes('idea=saved-post')); assert.equal(h.events.filter((event) => event.type === 'feedback-changed').length, 1); assert.equal(h.clearedDrafts.length, 1);
});
await test('pending synchronous duplicate is ignored and never auto-retried', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; }); const h = host({ responses: [() => gate] });
  const pending = h.submit(); h.render(); assert.equal(h.find((node) => node.props.type === 'submit').node.props.disabled, true);
  await h.submit(); assert.equal(h.calls.length, 1); release({ ok: false, code: 'request_failed', error: 'Try later' }); await pending; h.assertFailure('Try later'); assert.equal(h.calls.length, 1);
});
await test('unmounted account response cannot navigate or broadcast into a new session', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; }); const h = host({ responses: [() => gate] });
  const pending = h.submit(); h.unmount(); release({ ok: true, data: { id: 'old-account-post' } }); await pending;
  assert.equal(h.navigation.length, 0); assert.equal(h.events.length, 0); assert.equal(h.clearedDrafts.length, 0);
});
await test('search throw is handled as a search status and does not lose form input', async () => {
  const h = host({ searchThrows: true }); await h.runTimers(); assert.equal(h.state.reads, 1); assert(h.findAll((node) => node.props.role === 'status').some((node) => h.text(node).includes('feedbackLive.unexpected'))); h.assertRetained(); assert.equal(h.findAll((node) => node.props.role === 'alert').length, 0);
});
await test('malformed success cannot clear inputs or pretend to publish', async () => {
  const h = host({ responses: [{ ok: true, data: {} }] }); await h.submit(); h.assertFailure('feedbackLive.unexpected'); assert.equal(h.navigation.length, 0); assert.equal(h.clearedDrafts.length, 0);
});
console.log(`${passed} Composer regression cases passed against actual component handlers (mocked services).`);
