// Exercise the real notification component with delayed, fictional RPCs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const href = '/community/discussion/fixture-post#comment-33333333-3333-4333-8333-333333333333';
const item = { id: 'notice-1', type: 'reply', detail: null, href, read_at: null, actor_username: 'fictional-reader', actor_avatar_url: null, submission_title: 'Synthetic post', comment_preview: 'Synthetic reply', created_at: '2026-11-04T00:00:00Z' };
const tick = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

function harness({ mutation = async () => ({}), refresh } = {}) {
  let cursor = 0, slots = [], effects = [], tree, identity, reads = 0;
  const state = { userId: 'fictional-user', sessionEpoch: 1 };
  const pushes = [], transitions = [], writes = [];
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[index];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useCallback(callback, dependencies) {
      const index = cursor++, old = slots[index];
      if (!old || dependencies.some((value, position) => value !== old.dependencies[position])) slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = cursor++, old = slots[index];
      if (!old || dependencies.some((value, position) => value !== old.dependencies[position])) {
        const slot = { dependencies, cleanup: old?.cleanup }; slots[index] = slot;
        effects.push(() => { old?.cleanup?.(); slot.cleanup = effect(); });
      }
    },
    useTransition() { return [false, (callback) => { transitions.push(callback()); }]; },
  };
  const data = { items: [item], unread: 1, total: 1 };
  const imports = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next-intl': { useTranslations: () => (key) => key, useLocale: () => 'en', useFormatter: () => ({ dateTime: () => 'date' }) },
    '@/i18n/navigation': { Link: 'a', useRouter: () => ({ push: (value) => pushes.push(value) }) },
    '@/lib/supabase/client': { createClient: () => ({ rpc: async () => { reads++; return reads === 1 || !refresh ? { data, error: null } : refresh.promise; } }) },
    '@/app/actions/notifications': { mutateNotifications: async (...args) => { writes.push(args); return mutation(); } },
    '@/lib/types': { badgeInfo: () => null },
    '@/lib/auth-context': { useAuth: () => ({ user: state.userId ? { id: state.userId } : null, sessionEpoch: state.sessionEpoch, loading: false }) },
    '@/lib/auth-navigation': { getSignInHref: () => '/sign-in' },
    '@/components/auth-loading': { AuthLoading: 'loading' },
    '@/components/avatar': { Avatar: 'avatar' },
    '@/components/level-badge': { LevelBadge: 'level' },
    '@/lib/level': { levelTierName: () => 'tier' },
    '@/lib/notification-navigation': { safeNotificationHref: (value) => value },
  };
  const source = readFileSync(new URL('../../src/components/notification-bell.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const moduleForTest = { exports: {} };
  vm.runInNewContext(compiled, {
    module: moduleForTest, exports: moduleForTest.exports,
    require(name) { assert(name in imports, `Unexpected dependency: ${name}`); return imports[name]; },
    setInterval: () => 1, clearInterval() {}, document: { addEventListener() {}, removeEventListener() {} }, window: { confirm: () => true },
  }, { filename: 'notification-bell.tsx' });
  const Component = moduleForTest.exports.NotificationBell;
  function unmount() { for (const slot of slots) slot?.cleanup?.(); }
  function render() {
    const wrapper = Component({ fullPage: true });
    if (identity !== wrapper.key) { unmount(); slots = []; identity = wrapper.key; }
    cursor = 0; effects = []; tree = wrapper.type(wrapper.props); effects.forEach((effect) => effect());
  }
  function find(node, predicate) {
    if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return; }
    if (!node || typeof node !== 'object') return;
    return predicate(node) ? node : find(node.props?.children, predicate);
  }
  return {
    state, pushes, transitions, writes, render, unmount, get reads() { return reads; },
    async ready() { render(); await tick(); render(); },
    click() { const button = find(tree, (node) => node.type === 'button' && node.key === item.id); assert(button); button.props.onClick(); },
    clickAction(name) { const button = find(tree, (node) => node.type === 'button' && (node.props?.children === name || node.props?.['aria-label'] === name)); assert(button); button.props.onClick(); },
    hasError() { return Boolean(find(tree, (node) => node.props?.role === 'alert')); },
  };
}

test('a successful read navigates even while refreshing the notification list is delayed', async () => {
  const refresh = deferred(), h = harness({ refresh });
  await h.ready(); h.click(); await tick();
  assert.equal(h.reads, 2);
  assert.deepEqual(h.pushes, [href]);
  let settled = false; h.transitions[0].then(() => { settled = true; }); await tick();
  assert(settled, 'a stalled refresh must not keep notification controls disabled after navigation');
  refresh.resolve({ data: { items: [], unread: 0, total: 0 }, error: null });
  await Promise.all(h.transitions); h.unmount();
});

for (const action of ['markAllRead', 'clearAll']) {
  test(`${action} still waits for its list refresh`, async () => {
    const refresh = deferred(), h = harness({ refresh });
    await h.ready(); h.clickAction(action); await tick();
    let settled = false; h.transitions[0].then(() => { settled = true; }); await tick();
    assert.equal(h.reads, 2); assert.equal(settled, false); assert.deepEqual(h.pushes, []);
    refresh.resolve({ data: { items: [], unread: 0, total: 0 }, error: null });
    await Promise.all(h.transitions); h.unmount();
  });
}

test('a failed read reports an error without navigating or claiming success', async () => {
  const h = harness({ mutation: async () => ({ error: 'synthetic failure' }) });
  await h.ready(); h.click(); await Promise.all(h.transitions); h.render();
  assert.deepEqual(h.pushes, []); assert.equal(h.reads, 1); assert(h.hasError()); h.unmount();
});

test('a read completing after the account changes cannot navigate the new session', async () => {
  const mutation = deferred(), h = harness({ mutation: () => mutation.promise });
  await h.ready(); h.click(); h.state.userId = null; h.state.sessionEpoch++; h.render();
  mutation.resolve({}); await Promise.all(h.transitions);
  assert.deepEqual(h.pushes, []); assert.equal(h.reads, 1); h.unmount();
});
