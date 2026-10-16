import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_DEV_ACCOUNTS, isLocalDevAuthConfigured } from '../src/lib/local-dev-auth.ts';

loadEnvFile('.env.local');
assert(isLocalDevAuthConfigured({ ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'development', LOCAL_DEV_AUTH_ENABLED: 'true' }),
  'Local development auth requires the local Supabase at 127.0.0.1:54321 and the local site on port 4000.');
assert(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  'Configure both local Supabase keys first.');
const password = process.env.LOCAL_DEV_AUTH_PASSWORD || randomBytes(32).toString('base64url');
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

for (const account of LOCAL_DEV_ACCOUNTS) {
  const { data, error } = await client.auth.admin.getUserById(account.userId);
  if (error && error.code !== 'user_not_found') throw new Error(`Cannot inspect local account: ${error.code ?? 'unknown'}`);
  if (data.user) {
    assert(data.user.email === account.email && data.user.app_metadata.local_dev_auth === true,
      'Refusing to modify an account not owned by this local development setup.');
    // Reapplying an unchanged password revokes existing sessions. Verify it first and
    // revoke only this short-lived probe session, leaving browser sessions intact.
    const probe = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const signedIn = await probe.auth.signInWithPassword({ email: account.email, password });
    if (signedIn.error) {
      assert.equal(signedIn.error.code, 'invalid_credentials', 'Cannot verify the existing local account.');
      const result = await client.auth.admin.updateUserById(account.userId, { password });
      assert.ifError(result.error);
    } else {
      assert.ifError((await probe.auth.signOut({ scope: 'local' })).error);
    }
  } else {
    const result = await client.auth.admin.createUser({
      id: account.userId, email: account.email, password, email_confirm: true,
      app_metadata: { local_dev_auth: true },
      user_metadata: { username: account.username, display_name: account.name },
    });
    assert.ifError(result.error);
  }
  const result = await client.from('profiles').update({ role: account.role, display_name: account.name,
    onboarded_at: new Date().toISOString() }).eq('id', account.userId).select('id').single();
  assert.ifError(result.error);
  assert.equal(result.data.id, account.userId);
  console.log(`Ready: ${account.name} (${account.role})`);
}

let content = await readFile('.env.local', 'utf8');
for (const [key, value] of Object.entries({ LOCAL_DEV_AUTH_ENABLED: 'true', LOCAL_DEV_AUTH_PASSWORD: password })) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content) ? content.replace(pattern, () => `${key}=${value}`) : `${content.trimEnd()}\n${key}=${value}\n`;
}
await writeFile('.env.local', content, { mode: 0o600 });
await chmod('.env.local', 0o600);
console.log('Local one-click login enabled: http://localhost:4000/zh/dev/login');
console.log('Random credentials remain server-only in ignored .env.local; no password printed.');
