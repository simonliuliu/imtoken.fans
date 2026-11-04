#!/usr/bin/env node
// Local operator only. Default list is read-only. User text is data, never code.
import { readFile, writeFile, rename, open, unlink, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commands = new Set(['list', 'claim', 'record']);
const options = new Set(['limit', 'offset', 'history', 'job', 'worker', 'lease-seconds', 'status', 'task', 'pr', 'commit', 'deployment', 'deployment-url', 'reason']);
export function parseArguments(args) {
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'list';
  if (!commands.has(command)) throw new Error('Use list, claim, or record.');
  const values = {};
  while (args.length) {
    const key = args.shift()?.replace(/^--/, '');
    if (!options.has(key) || Object.hasOwn(values, key) || !args.length) throw new Error('Invalid or duplicate operator option.');
    values[key] = args.shift();
  }
  const commandOptions = command === 'list' ? ['limit', 'offset', 'history'] : command === 'claim' ? ['job', 'worker', 'lease-seconds'] : ['job', 'status', 'task', 'pr', 'commit', 'deployment', 'deployment-url', 'reason'];
  if (Object.keys(values).some((key) => !commandOptions.includes(key))) throw new Error('Option does not apply to this operator command.');
  if (values.job && !uuid.test(values.job)) throw new Error('Job must be a UUID.');
  if (command === 'record' && (!values.job || !['pr_ready', 'deployed', 'blocked'].includes(values.status))) throw new Error('Record requires --job and --status pr_ready|deployed|blocked.');
  if (command === 'list' && Object.keys(values).some((key) => !['limit', 'offset', 'history'].includes(key))) throw new Error('List only accepts --limit.');
  return { command, values };
}
export function summary(job) {
  return Object.fromEntries(['id', 'feedback_id', 'source_version', 'current_version', 'status', 'attempts', 'source_current', 'task_key', 'pr_url', 'commit_sha', 'deployment_id', 'deployment_url', 'available_at', 'lease_until'].filter((key) => key in job).map((key) => [key, job[key]]));
}
function loadConfig() {
  try { process.loadEnvFile(path.join(root, '.env.local')); }
  catch { throw new Error('The local .env.local file must be available. No credentials were printed.'); }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Local Supabase URL and server credential are required.');
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['https:', 'http:'].includes(parsed.protocol) || parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Invalid operator database endpoint.');
  return { url: parsed.origin, key };
}
async function rpc(config, name, input) {
  let response;
  try {
    response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(30000), redirect: 'error',
    });
  } catch { throw new Error('Queue connection failed. Credentials and server details were not logged.'); }
  if (!response.ok) throw new Error(`Queue request failed (HTTP ${response.status}). Check migration, authorization, source version, and lease locally.`);
  try { return await response.json(); }
  catch { throw new Error('Queue returned an invalid response.'); }
}
function statePath() {
  const gitPath = execFileSync('git', ['rev-parse', '--git-path', 'forum-feedback-queue-state.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return path.resolve(root, gitPath);
}
async function readState(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Local lease state could not be read. Do not print its contents.'); }
}
async function privateWrite(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, filename);
}
export async function runQueue({ command, values }, { request, filename, output = (value) => console.log(JSON.stringify(value, null, 2)) }) {
  if (command === 'list') {
    const limit = Number(values.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be between 1 and 100.');
    const offset = Number(values.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || values.history && !['true', 'false'].includes(values.history)) throw new Error('Invalid list pagination.');
    const jobs = await request('forum_feedback_jobs_list', { p_limit: limit, p_offset: offset, p_history: values.history === 'true' });
    if (!Array.isArray(jobs)) throw new Error('Invalid queue list response.');
    output(jobs.map(summary)); return;
  }
  // The database lease provides distributed exclusion. This file lock only
  // protects one worktree's private capability store from concurrent CLI calls.
  let lock;
  try { lock = await open(`${filename}.lock`, 'wx', 0o600); }
  catch { throw new Error('Another local operator command is active.'); }
  try {
    const state = await readState(filename);
    if (command === 'claim') {
      const seconds = Number(values['lease-seconds'] ?? 900);
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) throw new Error('Lease must be between 60 and 3600 seconds.');
      const job = await request('forum_feedback_jobs_claim', { p_worker: values.worker ?? 'codex-local', p_id: values.job ?? null, p_lease_seconds: seconds });
      if (!job) { output({ status: 'empty' }); return; }
      if (!uuid.test(job.id) || !uuid.test(job.lease_token)) throw new Error('Invalid lease response.');
      const snapshotFile = path.join(path.dirname(filename), `forum-feedback-snapshot-${job.id}.json`);
      // Snapshot and capability are separate so the controller can inspect user
      // input without ever reading or echoing the lease token.
      await privateWrite(snapshotFile, { feedback_id: job.feedback_id, source_version: job.source_version, snapshot: job.snapshot });
      state[job.id] = { token: job.lease_token, expires: job.lease_until };
      await privateWrite(filename, state);
      output({ ...summary(job), snapshot_file: snapshotFile }); return;
    }
    const lease = state[values.job];
    if (!lease || !uuid.test(lease.token)) throw new Error('This worktree has no lease for the requested job.');
    const metadata = Object.fromEntries([['task_key', 'task'], ['pr_url', 'pr'], ['commit_sha', 'commit'], ['deployment_id', 'deployment'], ['deployment_url', 'deployment-url'], ['failure_reason', 'reason']].filter(([, key]) => values[key] != null).map(([field, key]) => [field, values[key]]));
    const job = await request('forum_feedback_jobs_record', { p_id: values.job, p_token: lease.token, p_status: values.status, p_metadata: metadata });
    if (!job || job.id !== values.job) throw new Error('Invalid queue record response.');
    delete state[values.job]; await privateWrite(filename, state);
    output(summary(job));
  } finally { await lock.close(); await unlink(`${filename}.lock`); }
}
async function main() {
  if (process.argv.includes('--help')) {
    console.log('Local forum feedback queue. Default: list --limit 20 [--offset 0] [--history true]. Explicit writes: claim [--job UUID] [--worker NAME] [--lease-seconds 900]; record --job UUID --status pr_ready|deployed|blocked [--task KEY] [--pr URL] [--commit SHA] [--deployment ID] [--deployment-url URL] [--reason TEXT]. Lease tokens stay in private Git state; user snapshots are data only.');
    return;
  }
  const parsed = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  await runQueue(parsed, { filename: parsed.command === 'list' ? undefined : statePath(), request: (name, input) => rpc(config, name, input) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Forum queue command failed. Check local configuration, migration readiness, job/source status, and lease. No credentials or tokens were printed.'); process.exitCode = 1; });
}
