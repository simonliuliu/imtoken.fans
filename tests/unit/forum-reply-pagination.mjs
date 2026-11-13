// Exercise the real CommentItem pagination and hash handlers without a browser,
// network access, or real user data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const fixtures = (count) => Array.from({ length: count }, (_, index) => ({
  id: `reply-${index + 1}`,
  user_id: `fictional-user-${index + 1}`,
  author_username: `reader_${index + 1}`,
}));

function harness({ replies = fixtures(11), hash = "" } = {}) {
  let cursor = 0;
  let slots = [];
  let effects = [];
  let changed = false;
  let tree;
  const frames = new Map();
  let nextFrame = 0;
  const scrolled = [];
  const listeners = new Set();
  const location = { hash };
  let props = {
    comment: { id: "root", user_id: "fictional-root" },
    replies,
    submissionId: "fictional-post",
    isLoggedIn: true,
    canModerate: false,
    canPin: false,
    tagsByUser: {},
    onPosted(comment) {
      if (comment) props = { ...props, replies: [...props.replies, comment] };
    },
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[index];
      return [slot.value, (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; changed = true; }
      }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useCallback(callback, dependencies) {
      const index = cursor++;
      const old = slots[index];
      if (!old || dependencies.some((value, position) => !Object.is(value, old.dependencies[position]))) {
        slots[index] = { callback, dependencies };
      }
      return slots[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const old = slots[index];
      if (!old || dependencies.some((value, position) => !Object.is(value, old.dependencies[position]))) {
        const slot = { dependencies, cleanup: old?.cleanup };
        slots[index] = slot;
        effects.push(() => { old?.cleanup?.(); slot.cleanup = effect(); });
      }
    },
    useTransition() { return [false, (callback) => callback()]; },
  };
  const imports = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "next-intl": { useTranslations: () => (key) => key, useLocale: () => "en" },
    "@/i18n/navigation": { Link: "a", usePathname: () => "/community/discussion/post" },
    "@/components/avatar": { Avatar: "avatar" },
    "@/app/actions/comments": {},
    "@/app/actions/users": {},
    "@/lib/mentions": {},
    "@/lib/types": { COMMENT_REPORT_REASON_LABEL: {} },
    "@/components/user-badge-inline": { UserBadgeInline: "badge" },
    "@/components/user-hover-card": { UserHoverCard: "hover-card" },
    "@/components/modal": { Modal: "modal" },
    "@/lib/auth-navigation": {},
    "@/lib/auth-context": {},
    "@/components/auth-loading": { AuthLoading: "loading" },
  };
  function walk(node, predicate, found = []) {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, predicate, found);
    } else if (node && typeof node === "object") {
      if (predicate(node)) found.push(node);
      walk(node.props?.children, predicate, found);
    }
    return found;
  }
  const nodes = (name) => walk(tree, (node) => typeof node.type === "function" && node.type.name === name);
  const visible = () => nodes("CommentRow").map((node) => node.props.comment.id).filter((id) => id !== "root");
  const source = readFileSync(new URL("../../src/components/comment-form.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  vm.runInNewContext(compiled, {
    module: testModule, exports: testModule.exports,
    require(name) { assert(name in imports, `Unexpected dependency: ${name}`); return imports[name]; },
    window: {
      location,
      addEventListener(name, listener) { if (name === "hashchange") listeners.add(listener); },
      removeEventListener(name, listener) { if (name === "hashchange") listeners.delete(listener); },
    },
    document: { getElementById(id) {
      return visible().includes(id.replace(/^comment-/, "")) ? { scrollIntoView() { scrolled.push(id); } } : null;
    } },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  }, { filename: "comment-form.tsx" });
  const Component = testModule.exports.CommentItem;
  function render() {
    let count = 0;
    do {
      changed = false;
      effects = [];
      cursor = 0;
      tree = Component(props);
      for (const effect of effects) effect();
      assert(++count < 20, "Component effects should settle");
    } while (changed);
  }
  function flushFrames() {
    let count = 0;
    while (frames.size) {
      const current = [...frames.values()];
      frames.clear();
      for (const callback of current) callback();
      render();
      assert(++count < 20, "Animation frames should settle");
    }
  }
  function page(number) {
    const pagination = nodes("ReplyPagination")[0];
    assert(pagination, "Reply pagination should be available");
    pagination.props.onChange(number);
    render();
  }
  function remove(id) {
    const row = nodes("CommentRow").find((node) => node.props.comment.id === id);
    assert(row, `Reply ${id} should be visible before deletion`);
    row.props.onDeleted();
    render();
  }
  function queueHash(next) {
    location.hash = next;
    for (const listener of [...listeners]) listener();
  }
  function setHash(next) {
    queueHash(next);
    flushFrames();
  }
  render();
  flushFrames();
  return {
    visible, page, remove, setHash, queueHash, scrolled, render, flushFrames, nodes,
    replaceReplies(next) { props = { ...props, replies: next }; render(); flushFrames(); },
    refreshBeforeFrame(next) { props = { ...props, replies: next }; render(); },
    post(reply) {
      nodes("CommentRow").find((node) => node.props.comment.id === "root").props.onReplyClick();
      render();
      const form = nodes("CommentForm")[0];
      assert(form, "Reply form should be open");
      form.props.onPosted(reply);
      render();
      flushFrames();
    },
  };
}

test("deleting the only reply on the last page displays the preceding replies", () => {
  const h = harness();
  h.page(2);
  assert.deepEqual(h.visible(), ["reply-11"]);
  h.remove("reply-11");
  assert.deepEqual(h.visible(), fixtures(10).map((reply) => reply.id));
  assert.equal(h.nodes("ReplyPagination").length, 0);
});

test("a shorter refreshed reply list clamps the selected page and keeps it when the list grows", () => {
  const h = harness({ replies: fixtures(21) });
  h.page(3);
  h.replaceReplies(fixtures(11));
  assert.deepEqual(h.visible(), ["reply-11"]);
  h.replaceReplies(fixtures(22));
  assert.deepEqual(h.visible(), fixtures(20).slice(10).map((reply) => reply.id));
});

test("a notification anchor uses the visible position after a local deletion", () => {
  const h = harness();
  h.remove("reply-1");
  h.setHash("#comment-reply-11");
  assert(h.visible().includes("reply-11"));
  assert.deepEqual(h.scrolled, ["comment-reply-11"]);
});

test("posting a reply after arriving from an older notification keeps the new reply visible", () => {
  const h = harness({ replies: fixtures(10), hash: "#comment-reply-1" });
  h.post(fixtures(11)[10]);
  assert.deepEqual(h.visible(), ["reply-11"]);
  assert.deepEqual(h.scrolled, ["comment-reply-1"]);
});

test("returning to an earlier notification anchor reveals its page again", () => {
  const h = harness({ replies: fixtures(21), hash: "#comment-reply-11" });
  h.setHash("#comment-unrelated");
  h.page(1);
  h.setHash("#comment-reply-11");
  assert(h.visible().includes("reply-11"));
  assert.deepEqual(h.scrolled, ["comment-reply-11", "comment-reply-11"]);
});

test("a deletion before the queued anchor is revealed uses the updated position", () => {
  const h = harness({ replies: fixtures(21) });
  h.queueHash("#comment-reply-11");
  h.remove("reply-1");
  h.flushFrames();
  assert(h.visible().includes("reply-11"));
  assert.deepEqual(h.scrolled, ["comment-reply-11"]);
});

test("a server refresh before the queued anchor is revealed uses the refreshed position", () => {
  const h = harness({ replies: fixtures(21) });
  h.queueHash("#comment-reply-11");
  h.refreshBeforeFrame(fixtures(21).slice(1));
  h.flushFrames();
  assert(h.visible().includes("reply-11"));
  assert.deepEqual(h.scrolled, ["comment-reply-11"]);
});

test("a newer hash cancels a queued anchor for a different reply thread", () => {
  const h = harness({ replies: fixtures(21) });
  h.queueHash("#comment-reply-21");
  h.queueHash("#comment-other-thread");
  h.flushFrames();
  assert.deepEqual(h.visible(), fixtures(10).map((reply) => reply.id));
  assert.deepEqual(h.scrolled, []);
});
