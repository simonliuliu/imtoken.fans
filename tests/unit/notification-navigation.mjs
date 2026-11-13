// Run the real navigation validator and NotificationBell handlers without network
// access, real users, database writes, or additional dependencies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const POST = "22222222-2222-4222-8222-222222222222";
const COMMENT = "33333333-3333-4333-8333-333333333333";

function load(path, imports = {}, globals = {}) {
  const testModule = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module: testModule, exports: testModule.exports,
    require(name) { assert(name in imports, `Unexpected dependency: ${name}`); return imports[name]; },
    ...globals,
  }, { filename: path });
  return testModule.exports;
}
const { safeNotificationHref } = load("../../src/lib/notification-navigation.ts");

const supported = [
  `/community/feedback?category=forum&idea=${POST}`,
  `/community/feedback?category=forum&idea=${POST}&commentOffset=50#comment-${COMMENT}`,
  ...["safety", "discussion", "activities", "feedback"].flatMap((section) => [
    `/community/${section}/${POST}`,
    `/community/${section}/${POST}#comment-${COMMENT}`,
    `/community/${section}/learning-notebook`,
    `/community/${section}/learning-notebook#comment-${COMMENT}`,
  ]),
  ...["products", "ideas"].flatMap((kind) => [`/${kind}/${POST}`, `/${kind}/${POST}#comment-${COMMENT}`]),
  `/community/feedback?category=wallet&idea=${POST}`,
  `/community/feedback?category=wallet&idea=${POST}#comment-${COMMENT}`,
  `/community/feedback?category=wallet&idea=${POST}&commentOffset=50`,
  `/community/feedback?category=wallet&idea=${POST}&commentOffset=50#comment-${COMMENT}`,
];
for (const href of supported) {
  test(`accepts notification detail route ${href}`, () => assert.equal(safeNotificationHref(href), href));
}

const rejected = [
  null, undefined, "", "/", "/profile", "/admin", "/activities", "/community/safety", "/community/unknown/post",
  "https://example.test/community/safety/post", "http://example.test", "//example.test", "javascript:alert(1)",
  "data:text/html,test", "\\example.test", "/community/safety/\\example.test", "/community/safety//example.test",
  "/community/safety/../admin", "/community/safety/.", "/community/safety/%2e%2e", "/community/safety/%2fadmin",
  "/community/safety/%5cadmin", "/community/safety/post/extra", "/community/safety/post?redirect=//example.test",
  "/community/safety/post#comments", `/community/safety/post#comment-${COMMENT}?next=bad`,
  "/community/safety/-post", "/community/safety/post-", "/community/safety/Post", "/en/community/safety/post",
  "/community/safety/post\n", " /community/safety/post", "/community/safety/post\u0000",
  `/products/${"-".repeat(36)}`, `/products/${POST}?next=/admin`,
  `/community/feedback?idea=${POST}&category=wallet`, `/community/feedback?category=other&idea=${POST}`,
  `/community/feedback?category=wallet&idea=${POST}&extra=1`,
  `/community/feedback?category=wallet&idea=${POST}&commentOffset=-1`,
  `/community/feedback?category=wallet&idea=${POST}&commentOffset=50&commentOffset=100`,
];
for (const [index, href] of rejected.entries()) {
  test(`rejects unsupported or unsafe notification target ${index}: ${JSON.stringify(href)}`, () => assert.equal(safeNotificationHref(href), null));
}

function fixture(overrides = {}) {
  return {
    id: "notice-1", type: "reply", detail: null, href: `/community/safety/approval-checklist#comment-${COMMENT}`,
    read_at: null, actor_username: "Fictional reader", actor_avatar_url: null, submission_title: "Fictional safety post",
    comment_preview: "Fictional reply", created_at: "2026-11-03T08:00:00Z", ...overrides,
  };
}

function harness({ item = fixture(), locale = "zh", mutation = async () => ({}) } = {}) {
  let cursor = 0, slots = [], effects = [], tree, identity;
  const state = { userId: "fictional-reader", sessionEpoch: 0 };
  const calls = [], pushes = [], transitions = [];
  const translation = (key) => key;
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[index];
      return [slot.value, (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useCallback(callback, dependencies) {
      const index = cursor++;
      const old = slots[index];
      if (!old || dependencies.some((value, position) => value !== old.dependencies[position])) slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const old = slots[index];
      if (!old || dependencies.some((value, position) => value !== old.dependencies[position])) {
        const slot = { dependencies, cleanup: old?.cleanup };
        slots[index] = slot;
        effects.push(() => { old?.cleanup?.(); slot.cleanup = effect(); });
      }
    },
    useTransition() { return [false, (callback) => { const pending = callback(); transitions.push(pending); }]; },
  };
  const imports = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "next-intl": { useTranslations: () => translation, useLocale: () => locale, useFormatter: () => ({ dateTime: () => "fixture date" }) },
    "@/i18n/navigation": {
      Link: "a",
      // Verify the component's contract: hand the exact locale-free URL to the
      // shared router. Next-intl prefixing itself is checked in the browser.
      useRouter: () => ({ push(href) { pushes.push(href); } }),
    },
    "@/lib/supabase/client": { createClient: () => ({ rpc: async () => ({ data: { items: [item], unread: item.read_at ? 0 : 1, total: 1 }, error: null }) }) },
    "@/app/actions/notifications": { async mutateNotifications(...args) { calls.push(args); return mutation(...args); } },
    "@/lib/types": { badgeInfo: () => null },
    "@/lib/auth-context": { useAuth: () => ({ user: state.userId ? { id: state.userId } : null, sessionEpoch: state.sessionEpoch, loading: false }) },
    "@/lib/auth-navigation": { getSignInHref: () => "/auth/sign-in" },
    "@/components/auth-loading": { AuthLoading: "loading" },
    "@/components/avatar": { Avatar: "avatar" },
    "@/components/level-badge": { LevelBadge: "level" },
    "@/lib/level": { levelTierName: () => "fixture level" },
    "@/lib/notification-navigation": { safeNotificationHref },
  };
  const component = load("../../src/components/notification-bell.tsx", imports, {
    setInterval: () => 1, clearInterval() {},
    document: { addEventListener() {}, removeEventListener() {} }, window: { confirm: () => true },
  }).NotificationBell;
  function unmount() { for (const slot of slots) slot?.cleanup?.(); }
  function render() {
    const wrapper = component({ fullPage: true });
    if (identity !== wrapper.key) { unmount(); slots = []; identity = wrapper.key; }
    cursor = 0; effects = [];
    tree = wrapper.type(wrapper.props);
    effects.forEach((effect) => effect());
    return tree;
  }
  function find(node, predicate) {
    if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return; }
    if (!node || typeof node !== "object") return;
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
  }
  // VM component promises cross realms before invoking the host's async RPC
  // double. Drain the complete microtask queue before the next render, as React
  // would after that effect finishes, rather than assuming one Promise tick.
  async function ready() { render(); await new Promise(setImmediate); render(); }
  function click() {
    const button = find(tree, (node) => node.type === "button" && node.key === item.id);
    assert(button, "Actual NotificationBell notification button must be rendered");
    button.props.onClick();
  }
  async function settle() { await Promise.all(transitions); await new Promise(setImmediate); render(); }
  return { state, calls, pushes, ready, click, settle, render, unmount, findAlert: () => find(tree, (node) => node.props?.role === "alert") };
}

for (const locale of ["zh", "en"]) {
  test(`unread forum reply marks read then hands its exact comment to the shared router in ${locale}`, async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({ locale, mutation: () => gate });
    await h.ready(); h.click();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0], ["fictional-reader", "read", "notice-1"]);
    assert.equal(h.pushes.length, 0, "Do not navigate before the read mutation succeeds");
    release({}); await h.settle();
    assert.deepEqual(h.pushes, [fixture().href]);
    h.unmount();
  });
  test(`already-read forum post navigates directly without another mutation in ${locale}`, async () => {
    const href = `/community/discussion/${POST}`;
    const h = harness({ locale, item: fixture({ href, read_at: "2026-11-03T08:01:00Z" }) });
    await h.ready(); h.click();
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.pushes, [href]);
    h.unmount();
  });
}

for (const response of [{ error: "read rejected" }, new Error("transport failed")]) {
  test(`failed mark-read does not navigate: ${response instanceof Error ? "transport" : "action"}`, async () => {
    const h = harness({ mutation: async () => { if (response instanceof Error) throw response; return response; } });
    await h.ready(); h.click(); await h.settle();
    assert.equal(h.pushes.length, 0); assert(h.findAlert()); h.unmount();
  });
}

for (const href of [null, "javascript:alert(1)"]) {
  test(`an unread notification with target ${href} can be marked read without navigation`, async () => {
    const h = harness({ item: fixture({ href }) });
    await h.ready(); h.click(); await h.settle();
    assert.equal(h.calls.length, 1); assert.equal(h.pushes.length, 0); h.unmount();
  });
  test(`an already-read notification with target ${href} never navigates`, async () => {
    const h = harness({ item: fixture({ href, read_at: "2026-11-03T08:01:00Z" }) });
    await h.ready(); h.click();
    assert.equal(h.calls.length, 0); assert.equal(h.pushes.length, 0); h.unmount();
  });
}

for (const [type, href] of [["level_up", "/profile"], ["badge", "/profile"], ["xp_adjust", "/profile"], ["lottery_ticket", "/activities"]]) {
  test(`system notification ${type} keeps its trusted destination`, async () => {
    const h = harness({ item: fixture({ type, href: "javascript:alert(1)", detail: { level: 2, amount: 1 } }) });
    await h.ready(); h.click(); await h.settle();
    assert.deepEqual(h.pushes, [href]); h.unmount();
  });
}

for (const changeAccount of [false, true]) {
  test(`late mark-read success after ${changeAccount ? "account switch" : "unmount"} cannot navigate`, async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({ mutation: () => gate });
    await h.ready(); h.click();
    if (changeAccount) { h.state.userId = "another-fictional-reader"; h.state.sessionEpoch++; h.render(); }
    else h.unmount();
    release({}); await h.settle();
    assert.equal(h.pushes.length, 0); h.unmount();
  });
}
