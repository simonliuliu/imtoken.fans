import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL("../../src/app/admin/actions.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup({ authorised = true, rpcResult = { error: null }, throws = false } = {}) {
  const calls = { clients: 0, rpc: [], paths: [] };
  const modules = {
    "next/cache": { revalidatePath: (path) => calls.paths.push(path) },
    "@/lib/supabase/admin": { createAdminClient: () => {
      calls.clients += 1;
      return { rpc: async (name, input) => {
        calls.rpc.push({ name, input });
        if (throws) throw new Error("private diagnostic");
        return rpcResult;
      } };
    } },
    "@/lib/admin-guard": {
      requirePermission: async (key) => {
        assert.equal(key, "manage_user_tags");
        return authorised ? { profile: { id: "actor-id" } } : { error: "没有权限执行这个操作" };
      },
    },
    "@/lib/admin-moderation": {},
    "@/lib/badges": {},
    "@/lib/notify": {},
    "@/lib/xp": {},
    "@/lib/types": { BADGE_INFO: {}, PERMANENT_MUTE_UNTIL: "", muteDurationLabel: () => "" },
  };
  const target = { exports: {} };
  vm.runInNewContext(source, {
    module: target, exports: target.exports, console, Date, Set,
    require: (id) => id in modules ? modules[id] : require(id),
  });
  return { setUserTag: target.exports.setUserTag, calls };
}

test("unprivileged actor is rejected before creating an admin client", async () => {
  const instance = setup({ authorised: false });
  assert.equal((await instance.setUserTag("target-id", "blacklisted", true)).error, "没有权限执行这个操作");
  assert.equal(instance.calls.clients, 0);
});

test("add and remove pass the verified actor to the atomic RPC", async () => {
  for (const on of [true, false]) {
    const instance = setup();
    assert.equal((await instance.setUserTag("target-id", "blacklisted", on)).error, undefined);
    assert.equal(instance.calls.rpc.length, 1);
    assert.equal(instance.calls.rpc[0].name, "admin_set_user_tag");
    assert.equal(instance.calls.rpc[0].input.p_actor, "actor-id");
    assert.equal(instance.calls.rpc[0].input.p_user_id, "target-id");
    assert.equal(instance.calls.rpc[0].input.p_tag_key, "blacklisted");
    assert.equal(instance.calls.rpc[0].input.p_on, on);
    assert(instance.calls.paths.includes("/admin/users"));
  }
});

test("a returned or thrown RPC failure reports uncertainty without exposing details", async () => {
  for (const config of [{ rpcResult: { error: { message: "private diagnostic" } } }, { throws: true }]) {
    const instance = setup(config);
    const result = await instance.setUserTag("target-id", "vip", true);
    assert.equal(result.error, "标签操作结果未确认，请刷新页面核对后再试");
    assert(!result.error.includes("private"));
    assert.equal(instance.calls.paths.length, 0);
  }
});
