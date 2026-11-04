// Render actual admin components with synthetic data and deterministic hooks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = (path) => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const jsx = (type, props) => ({ type, props: props ?? {} });
function find(node, predicate) {
  if (Array.isArray(node)) { for (const child of node) { const match = find(child, predicate); if (match) return match; } return; }
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object') return text(node.props?.children);
  return node == null ? '' : String(node);
}
function load(code, imports) {
  const output = { exports: {} };
  vm.runInNewContext(code, { module: output, exports: output.exports, require(name) { assert(name in imports, name); return imports[name]; }, Number, Date, console });
  return output.exports;
}

test('content page exposes the existing post filter and passes it to the data query', async () => {
  const queries = [];
  const page = load(compile('../../src/app/admin/content/page.tsx'), {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '@/lib/admin-guard': { requireAdmin: async () => ({ role: 'admin' }), hasPermission: () => true },
    '@/lib/admin-data': { getAdminStats: async () => ({ pendingQueue: 0, publishedSubmissions: 0, trashItems: 0 }), getPendingQueueItems: async () => [], getSubmissionsForAdmin: async (filters) => { queries.push(filters); return { total: 0, page: 1, pageSize: 25, rows: [] }; } },
    '@/components/admin/moderation-queue-panel': { ModerationQueuePanel: 'queue' },
    '@/components/admin/submission-table': { SubmissionTable: 'table' },
    '@/components/admin/list-controls': { FilterTabs: 'filters', Pagination: 'pagination', SearchInput: 'search' },
    '@/components/admin/ui': { AdminPanel: 'panel', NoPermissionNotice: 'denied' },
  });
  const tree = await page.default({ searchParams: Promise.resolve({ type: 'post' }) });
  const types = find(tree, (node) => node.type === 'filters' && node.props.paramKey === 'type');
  assert(types.props.options.some((option) => option.value === 'post' && option.label === '社区帖子'));
  assert.equal(queries[0].type, 'post');
});

test('consecutive admin status changes use the revision returned by the previous change', async () => {
  let cursor = 0, slots = [], tree, pending = [];
  const calls = [];
  const hooks = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: initial }; const slot = slots[index]; return [slot.value, (value) => { slot.value = typeof value === 'function' ? value(slot.value) : value; }]; },
    useTransition() { return [false, (fn) => { pending.push(fn()); }]; },
  };
  const component = load(compile('../../src/components/admin/submission-table.tsx'), {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/link': { default: 'link' }, 'next/navigation': { useRouter: () => ({ refresh() {} }) },
    '@/app/admin/actions': { deleteSubmission: async () => ({}), setSubmissionStatus: async (id, status, revision) => { calls.push({ id, status, revision }); return { revision: revision + 1 }; } },
    '@/components/admin/ui': { EmptyState: 'empty', StatusPill: 'status', TimeAgo: 'time', TypePill: 'type' },
  });
  const submission = { id: 'synthetic-id', type: 'post', status: 'pending', moderation_revision: 0, title: 'Synthetic', tagline: 'Synthetic', created_at: '2026-11-04T00:00:00Z', community_section: 'discussion' };
  function render() { cursor = 0; tree = component.SubmissionTable({ submissions: [submission] }); }
  async function click(label) {
    const button = find(tree, (node) => node.type === 'button' && text(node) === label);
    assert(button, label); button.props.onClick(); await Promise.all(pending); pending = []; render();
  }
  render(); await click('设为已发布'); await click('设为待审核');
  assert.deepEqual(calls, [{ id: 'synthetic-id', status: 'published', revision: 0 }, { id: 'synthetic-id', status: 'pending', revision: 1 }]);
});
