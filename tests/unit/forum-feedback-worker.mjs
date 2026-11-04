// Operator contract only; injected RPCs, temporary local files, no environment or network.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArguments, runQueue } from '../../scripts/forum-feedback-queue.mjs';
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const job = { id: ID, feedback_id: ID, source_version: 1, status: 'claimed', lease_token: TOKEN, lease_until: '2099-01-01T00:00:00Z', snapshot: { title: 'Fictional feedback', description: '$(touch /never-execute-user-input)' } };
test('default command only lists and prints no source text or capability', async () => {
  const calls = [], output = [];
  await runQueue(parseArguments([]), { request: async (...args) => { calls.push(args); return [job]; }, output: (value) => output.push(value) });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'forum_feedback_jobs_list');
  assert(!JSON.stringify(output).includes(TOKEN)); assert(!JSON.stringify(output).includes('never-execute'));
});
test('claim keeps token and snapshot separate in private files and record uses stored capability', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forum-operator-'));
  try {
    const filename = path.join(directory, 'state.json'), output = [], calls = [];
    const request = async (name, input) => { calls.push([name, input]); return name.endsWith('claim') ? job : { ...job, status: 'pr_ready', pr_url: input.p_metadata.pr_url }; };
    await runQueue(parseArguments(['claim', '--worker', 'fixture-worker']), { request, filename, output: (value) => output.push(value) });
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    const snapshot = output[0].snapshot_file;
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    assert(!JSON.stringify(output).includes(TOKEN)); assert(!JSON.stringify(output).includes('never-execute'));
    assert(!(await readFile(snapshot, 'utf8')).includes(TOKEN));
    assert((await readFile(snapshot, 'utf8')).includes('$(touch /never-execute-user-input)'));
    assert.equal(JSON.parse(await readFile(filename, 'utf8'))[ID].token, TOKEN);
    await runQueue(parseArguments(['record', '--job', ID, '--status', 'pr_ready', '--pr', 'https://github.com/simonliuliu/imtoken.fans/pull/1']), { request, filename, output: (value) => output.push(value) });
    assert.equal(calls[1][1].p_token, TOKEN); assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), {});
    assert(!JSON.stringify(output).includes(TOKEN));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('empty claim is normal and creates no lease state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forum-empty-'));
  try {
    const filename = path.join(directory, 'state.json'), output = [];
    await runQueue(parseArguments(['claim']), { request: async () => null, filename, output: (value) => output.push(value) });
    assert.deepEqual(output, [{ status: 'empty' }]); await assert.rejects(access(filename));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('a concurrent local operator lock refuses a second claim before RPC', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forum-lock-'));
  try {
    const filename = path.join(directory, 'state.json'); await writeFile(filename + '.lock', '', { mode: 0o600 });
    await assert.rejects(() => runQueue(parseArguments(['claim']), { filename, request: async () => { assert.fail('RPC must not run'); } }), /Another local operator/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('operator refuses token arguments, invalid IDs, and mutating options on list', () => {
  for (const args of [['record', '--token', TOKEN], ['claim', '--job', 'bad'], ['list', '--job', ID], ['record', '--job', ID, '--status', 'done']]) assert.throws(() => parseArguments(args));
});
