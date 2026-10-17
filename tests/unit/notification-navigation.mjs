import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
const testModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../../src/lib/notification-navigation.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: testModule.exports, module: testModule });
const { safeNotificationHref } = testModule.exports;
const id = "11111111-1111-4111-8111-111111111111";
test("accepts emitted community slugs and UUID post comment links", () => {
  for (const path of [`/products/${id}`, `/ideas/${id}#comment-${id}`, `/community/feedback?category=wallet&idea=${id}&commentOffset=50#comment-${id}`, `/community/activities/weekend-conversation#comment-${id}`, `/community/activities/${id}#comment-${id}`, `/community/discussion/${id}`, `/community/safety/approval-checklist`]) assert.equal(safeNotificationHref(path), path);
});
test("rejects external, encoded and unrecognized notification destinations", () => {
  for (const path of [null, "https://example.invalid", "//example.invalid", "/\\example.invalid", "/community/activities/../admin", "/community/activities/%2e%2e", "/community/activities/%2fadmin", "/community/unknown/post", "/admin", `/community/activities/${id}?redirect=evil`, `/community/activities/test#comment-invalid`, "/community/activities/test\n"]) assert.equal(safeNotificationHref(path), null);
});
