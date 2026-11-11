// Operator contract only; injected RPCs, temporary local files, no environment or network.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
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
test('list exposes recovery and attention flags without private source text', async () => {
  const output = [];
  await runQueue(parseArguments([]), { request: async () => [{ ...job, requires_attention: true, requires_resume: true, lease_reclaims: 5 }], output: (value) => output.push(value) });
  assert.equal(output[0][0].requires_attention, true);
  assert.equal(output[0][0].requires_resume, true);
  assert.equal(output[0][0].lease_reclaims, 5);
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
test('renew checkpoints the existing task without exposing its lease token', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forum-renew-'));
  try {
    const filename = path.join(directory, 'state.json'), output = [], calls = [];
    const request = async (name, input) => {
      calls.push([name, input]);
      return name.endsWith('claim') ? job : { ...job, lease_token: undefined, task_key: input.p_metadata.task_key, lease_until: '2099-01-01T01:00:00Z' };
    };
    await runQueue(parseArguments(['claim']), { request, filename, output: (value) => output.push(value) });
    await runQueue(parseArguments(['renew', '--job', ID, '--task', 'existing-task']), { request, filename, output: (value) => output.push(value) });
    assert.equal(calls[0][1].p_lease_seconds, 3600);
    assert.equal(calls[1][0], 'forum_feedback_jobs_renew');
    assert.equal(calls[1][1].p_token, TOKEN); assert.equal(calls[1][1].p_metadata.task_key, 'existing-task');
    assert.equal(JSON.parse(await readFile(filename, 'utf8'))[ID].expires, '2099-01-01T01:00:00Z');
    assert(!JSON.stringify(output).includes(TOKEN));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('an uncertain record response leaves the local lease intact for reconciliation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forum-uncertain-'));
  try {
    const filename = path.join(directory, 'state.json');
    await runQueue(parseArguments(['claim']), { filename, request: async () => job, output: () => {} });
    await assert.rejects(() => runQueue(parseArguments(['record', '--job', ID, '--status', 'pr_ready', '--pr', 'https://github.com/simonliuliu/imtoken.fans/pull/1']), {
      filename, request: async () => { throw new Error('fictional lost response'); }, output: () => {},
    }), /fictional lost response/);
    assert.equal(JSON.parse(await readFile(filename, 'utf8'))[ID].token, TOKEN);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('a process-held local lock survives exec and is released after SIGKILL', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forum-lock-'));
  const filename = path.join(directory, 'state.lock');
  const wrapper = fileURLToPath(new URL('../../scripts/forum-feedback-lock.py', import.meta.url));
  const program = 'import importlib.util,os,sys; s=importlib.util.spec_from_file_location("forum_lock",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); fd=m.acquire_lock(sys.argv[2]); os.execv(sys.argv[3],[sys.argv[3],"-e","process.stdout.write(\'READY\');process.stdin.resume()"] )';
  const contender = 'import importlib.util,sys; s=importlib.util.spec_from_file_location("forum_lock",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.acquire_lock(sys.argv[2])';
  let owner;
  try {
    owner = spawn('python3', ['-B', '-c', program, wrapper, filename, process.execPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; owner.stderr.on('data', (chunk) => { stderr += chunk; });
    const started = await Promise.race([
      once(owner.stdout, 'data').then(([chunk]) => ({ ready: chunk.toString() })),
      once(owner, 'exit').then(([code, signal]) => ({ error: `exit ${code} ${signal}: ${stderr}` })),
    ]);
    assert.match(started.ready ?? '', /READY/, started.error);
    assert.notEqual(spawnSync('python3', ['-B', '-c', contender, wrapper, filename]).status, 0);
    owner.kill('SIGKILL'); await once(owner, 'exit'); owner = undefined;
    assert.equal(spawnSync('python3', ['-B', '-c', contender, wrapper, filename]).status, 0);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  } finally {
    if (owner) owner.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
test('direct Node queue writes refuse to run without the process-held lock', () => {
  const script = fileURLToPath(new URL('../../scripts/forum-feedback-queue.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'claim'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Forum queue command failed/);
});
test('operator refuses token arguments, invalid IDs, and mutating options on list', () => {
  for (const args of [['record', '--token', TOKEN], ['claim', '--job', 'bad'], ['list', '--job', ID], ['renew'], ['record', '--job', ID, '--status', 'done']]) assert.throws(() => parseArguments(args));
});
