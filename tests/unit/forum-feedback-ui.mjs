// Actual feedback feed effects and category controls with synthetic data only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const forumPost = { id: ID, module: 'forum', title: 'Forum fixture', description: 'Synthetic report', kind: 'bug', details: { steps: 'Click a notification' }, status: 'inbox', mark: 'none', visibility: 'published', version: 1, created_at: '2026-11-03T08:00:00Z', author_name: 'Fixture reader', support_count: 0, comment_count: 0, merge_id: null };
function host({ board = false, scope = 'forum', initialId = null, selected = null, sources = [] } = {}) {
  let cursor = 0, slots = [], effects = [], tree, id = 0;
  const timers = new Map(), events = new Map(), reads = [], openings = [], navigation = [];
  const location = new URL(`http://localhost:3000/zh/community/feedback?category=${scope === 'forum' ? 'forum' : 'wallet'}${initialId ? '&idea=' + initialId : ''}`);
  const window = { location, history: { state: null, replaceState(_state, _unused, url) { const target = new URL(url, location); location.href = target.href; } }, addEventListener: (name, listener) => events.set(name, listener), removeEventListener: (name) => events.delete(name) };
  const translation = (key) => key;
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const hooks = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; const slot = slots[index]; return [slot.value, (value) => { slot.value = typeof value === 'function' ? value(slot.value) : value; }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useCallback(callback, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((v, i) => v !== old.deps[i])) slots[index] = { callback, deps }; return slots[index].callback; },
    useEffect(effect, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((v, i) => v !== old.deps[i])) { const slot = { deps, cleanup: old?.cleanup }; slots[index] = slot; effects.push(() => { old?.cleanup?.(); slot.cleanup = effect(); }); } },
  };
  const modules = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/image': 'image', 'next-intl': { useTranslations: () => translation, useFormatter: () => ({ dateTime: () => 'fixture date', number: String }) },
    '@/lib/feedback-author': { feedbackForumName: (value) => value }, '@/lib/auth-context': { useAuth: () => ({ user: { id: 'reader' }, loading: false, isAdmin: false, sessionEpoch: 0 }) },
    '@/lib/feedback-drafts': { saveFeedbackDraft() {}, takeFeedbackDraft() {} },
    '@/i18n/navigation': { Link: 'a', useRouter: () => router },
    '@/app/actions/feedback': { writeFeedback: async () => ({ ok: true, data: { id: ID } }), readFeedback: async (query) => { reads.push(query); return { ok: true, data: { posts: selected ? [] : [forumPost], selected, viewer: { user_id: 'reader', can_manage: false }, total: 1, comments: [], comment_total: 0, sources, history: [] } }; } },
    '@/lib/feedback': { FEEDBACK_MODULES: ['wallet', 'forum'], FEEDBACK_STATES: ['inbox'], FEEDBACK_MARKS: ['none'], FEEDBACK_CHANGED: 'changed', FEEDBACK_COMPOSE: 'compose' },
    './cooperation-preview.module.css': { default: {} }, '@/components/comment-toolbar-icon': { CommentToolbarIcon: 'icon' }, '@/components/avatar': { Avatar: 'avatar' },
    '@/components/co-creation-feed-context': { CoCreationFeedContext: { Provider: 'context' } },
    '@/components/cooperation-preview': { CooperationPreview: 'feedback-feed' },
    '@/lib/community-demo': { SECTION_CATEGORIES: { feedback: ['wallet', 'forum', 'builds', 'changelog'] }, compareDemoPopularity: () => 0 },
    '@/components/level-badge': { LevelBadge: 'level' }, '@/components/token-personas-card': { TokenPersonasCard: 'personas' }, '@/components/community-elements': { CommunityGlyph: 'glyph' },
  };
  const router = { push: (href) => navigation.push(href), replace: (href) => navigation.push(href) };
  const file = board ? '../../src/components/community-preview.tsx' : '../../src/components/cooperation-preview.tsx';
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported = {};
  vm.runInNewContext(code, { exports: exported, require(name) { assert(name in modules, name); return modules[name]; }, window, URL, URLSearchParams, document: { getElementById: () => null }, setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); }, crypto: { randomUUID: () => ID } });
  function render() {
    cursor = 0; effects = [];
    const outer = board ? exported.CommunityBoard({ posts: [], section: 'feedback', initialCategory: scope === 'all' ? 'all' : scope === 'forum' ? 'forum' : 'wallet', initialId }) : exported.CooperationPreview({ scope, initialId, onOpen: open });
    if (board) { const findFeed = (node) => !node || typeof node !== 'object' ? null : typeof node.type === 'function' ? node : [node.props?.children].flat(Infinity).map(findFeed).find(Boolean); const feed = findFeed(outer); tree = feed.type(feed.props); }
    else tree = outer.type(outer.props);
    effects.forEach((effect) => effect());
  }
  const open = (...args) => openings.push(args);
  function walk(node, predicate) { if (Array.isArray(node)) { for (const child of node) { const match = walk(child, predicate); if (match) return match; } return; } if (!node || typeof node !== 'object') return; if (predicate(node)) return node; return walk(node.props?.children, predicate); }
  render();
  return { reads, openings, navigation, location, render, find: (predicate) => walk(tree, predicate), async tick() { const queued = [...timers.values()]; timers.clear(); for (const fn of queued) await fn(); render(); }, unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
test('forum feed reads only forum and product feed excludes forum', async () => { for (const scope of ['forum', 'product']) { const h = host({ scope }); await h.tick(); assert.equal(h.reads[0].module, scope); h.unmount(); } });
test('legacy wallet link to forum feedback resolves via all then canonicalizes without exposing another list', async () => { const h = host({ scope: 'product', initialId: ID, selected: forumPost }); await h.tick(); assert.equal(h.reads[0].module, 'all'); assert.equal(h.openings[0][0], 'forum'); assert.equal(h.openings[0][1], ID); assert.equal(h.location.searchParams.get('category'), 'forum'); h.unmount(); });
test('forum detail renders structured fields without parsing the description', async () => { const h = host({ initialId: ID, selected: forumPost }); await h.tick(); assert(h.find((node) => node.props?.['aria-label'] === 'structuredDetails')); h.unmount(); });
test('merged structured and legacy sources retain their individual details', async () => {
  const structured = { ...forumPost, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Structured source', description: 'Source body', details: { steps: 'Source-only steps' } };
  const legacy = { ...forumPost, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Legacy source', description: 'Old serialized text', kind: null, details: null };
  const h = host({ initialId: ID, selected: forumPost, sources: [structured, legacy] }); await h.tick();
  const sourcePanel = h.find((node) => node.type === 'details' && node.key === structured.id);
  const legacyPanel = h.find((node) => node.type === 'details' && node.key === legacy.id);
  assert(sourcePanel && legacyPanel);
  const text = (node) => Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
  assert(text(sourcePanel).includes('Source body')); assert(text(sourcePanel).includes('Source-only steps'));
  assert(text(legacyPanel).includes('Old serialized text')); assert(!text(legacyPanel).includes('structuredDetails'));
  h.unmount();
});
test('category switch clears old selection and uses the scoped feedback feed', () => { const h = host({ board: true, scope: 'product', initialId: ID }); const button = h.find((node) => node.type === 'button' && node.props.children === 'categories.forum'); assert(button); button.props.onClick(); h.render(); const feed = h.find((node) => node.type === 'feedback-feed'); assert.equal(feed.props.scope, 'forum'); assert.equal(feed.props.initialId, null); assert.equal(h.location.searchParams.get('category'), 'forum'); assert.equal(h.location.searchParams.get('idea'), null); h.unmount(); });

test('co-creation all view includes independent product and forum feeds', () => { const h=host({board:true,scope:'all'});assert(h.find(node=>node.type==='feedback-feed'&&node.props.scope==='product'));assert(h.find(node=>node.type==='feedback-feed'&&node.props.scope==='forum'));h.unmount(); });
