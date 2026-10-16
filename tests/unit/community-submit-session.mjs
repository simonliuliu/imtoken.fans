// Exercise the real Server Action with an isolated auth/RPC double. No database writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function setup(user, fail = false) {
  const calls = [];
  const testModule = { exports: {} };
  const imports = {
    "next/cache": { revalidatePath() {} },
    "next-intl/server": { getTranslations: async () => (key) => key },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, rpc: async (...args) => { calls.push(args); return fail ? { error: {} } : { data: "post-id" }; } }) },
  };
  const source = ts.transpileModule(readFileSync(new URL("../../src/app/actions/community.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, { module: testModule, exports: testModule.exports, require: (id) => imports[id] });
  return { action: testModule.exports.createCommunityPost, calls };
}
const input = { expectedUser: "original-user", requestId: "stable-request", section: "discussion", category: "general", title: "Example", body: "A sufficiently long body" };

test("expired community session offers sign-in without attempting RPC", async () => {
  const { action, calls } = setup(null);
  assert.equal((await action(input)).code, "sign_in");
  assert.equal(calls.length, 0);
});
test("changed community account never submits the old account's draft", async () => {
  const { action, calls } = setup({ id: "other-user" });
  assert.equal((await action(input)).code, "session_changed");
  assert.equal(calls.length, 0);
});
test("community RPC preserves request ID and surfaces failure instead of success", async () => {
  const { action, calls } = setup({ id: "original-user" }, true);
  assert.equal((await action(input)).error, "saveFailed");
  assert.equal(calls[0][1].p_request, input.requestId);
});
test("successful community RPC returns its real detail link", async () => {
  const { action } = setup({ id: "original-user" });
  assert.equal((await action(input)).href, "/community/discussion/post-id");
});
