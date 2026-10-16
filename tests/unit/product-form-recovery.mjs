// Render the actual product form with isolated React hooks and action doubles.
// This tests async state transitions without sending uploads or database writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);
const owner = "22222222-2222-4222-8222-222222222222";
const validDraft = { title: "Product", tagline: "A useful product", description: "A detailed description", tags: ["Web App"], websiteUrl: "https://example.test", videoUrl: "", logoPath: `${owner}/logo.png`, screenshotPaths: [`${owner}/shot.png`], team: [], socialLinks: [], productPlatforms: ["web"], pricingType: "free", launchStage: "live", makerRelationship: "creator", makerNote: "", feedbackPrompt: "" };
function setup(action, { storageUnavailable = false } = {}) {
  let cursor = 0;
  const hooks = [];
  const calls = [];
  const navigation = [];
  const react = {
    useEffect() {},
    useRef(value) { const index = cursor++; return hooks[index] ??= { current: value }; },
    useState(value) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = index === 0 ? { product: { ...validDraft }, idea: { title: "Preserved historical idea" } } : index === 5 ? true : value;
      return [hooks[index], (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
  };
  const testModule = { exports: {} };
  const imports = {
    react,
    "next-intl": { useLocale: () => "en", useTranslations: () => (key, values) => values?.fields ? `${key}: ${values.fields}` : key },
    "@/i18n/navigation": { Link: "a", useRouter: () => ({ push: (href) => navigation.push(href) }) },
    "@/lib/auth-context": { useAuth: () => ({ user: { id: owner, name: "Tester" }, loading: false, sessionEpoch: 1 }) },
    "@/lib/auth-navigation": { getSignInHref: () => "/en/auth/sign-in?next=/en/submit/product" },
    "@/app/actions/submissions": { createSubmission: async (input) => { calls.push(input); return action(input); } },
    "@/lib/media": { MAX_SCREENSHOTS: 8 },
    "@/lib/product-hunter": { PRODUCT_LAUNCH_STAGES: [], PRODUCT_PRICING: [], MAKER_RELATIONSHIPS: [] },
  };
  const source = ts.transpileModule(readFileSync(new URL("../../src/components/product-submission-form.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(source, { module: testModule, exports: testModule.exports, require: (id) => id in imports ? imports[id] : id === "react/jsx-runtime" ? require(id) : {}, queueMicrotask, window: { localStorage: { setItem() { if (storageUnavailable) throw new Error("Storage unavailable"); } } } });
  const content = testModule.exports.ProductSubmissionForm().type;
  return { hooks, calls, navigation, render() { cursor = 0; return content(); } };
}
function find(node, match) {
  if (!node || typeof node !== "object") return undefined;
  if (match(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const result = find(child, match); if (result) return result; }
}
const form = (tree) => find(tree, (node) => node.type === "form");
const submitButton = (tree) => find(tree, (node) => node.type === "button" && node.props.type === "submit");
const event = { preventDefault() {} };

test("thrown product action restores the submit button and keeps the exact draft", async () => {
  const harness = setup(async () => { throw new Error("Disconnected"); });
  await form(harness.render()).props.onSubmit(event);
  assert.equal(submitButton(harness.render()).props.disabled, false);
  assert.equal(find(harness.render(), (node) => node.props?.role === "alert").props.children, "unexpectedError");
  assert.equal(harness.hooks[0].product.title, validDraft.title);
  assert.equal(harness.calls[0].expectedUser, owner);
});

test("rapid repeated submit invokes product action once while busy", async () => {
  let release;
  const harness = setup(() => new Promise((resolve) => { release = resolve; }));
  const handler = form(harness.render()).props.onSubmit;
  const pending = handler(event);
  await handler(event);
  assert.equal(harness.calls.length, 1);
  assert.equal(submitButton(harness.render()).props.disabled, true);
  release({ error: "Retry later" });
  await pending;
  assert.equal(submitButton(harness.render()).props.disabled, false);
});

test("expired product session exposes a sign-in return link and retains its draft", async () => {
  const harness = setup(async () => ({ error: "Sign in", code: "sign_in" }));
  await form(harness.render()).props.onSubmit(event);
  assert.ok(find(harness.render(), (node) => node.type === "button" && node.props.type === "button" && node.props.children === "signInPublish"));
  assert.equal(harness.hooks[0].product.title, validDraft.title);
});

test("successful product submission clears only the submitted product draft", async () => {
  const harness = setup(async () => ({ submissionId: "new-product", published: false }));
  await form(harness.render()).props.onSubmit(event);
  assert.equal(harness.hooks[0].product.title, "");
  assert.equal(harness.hooks[0].idea.title, "Preserved historical idea");
  assert.ok(find(harness.render(), (node) => node.type === "h1" && node.props.children === "successPending"));
});


test("failed product draft storage prevents a sign-in redirect from discarding the draft", async () => {
  const harness = setup(async () => ({ error: "Sign in", code: "sign_in" }), { storageUnavailable: true });
  await form(harness.render()).props.onSubmit(event);
  find(harness.render(), (node) => node.type === "button" && node.props.children === "signInPublish").props.onClick();
  assert.equal(harness.navigation.length, 0);
  assert.equal(find(harness.render(), (node) => node.props?.role === "alert").props.children, "draftUnavailable");
  assert.equal(harness.hooks[0].product.title, validDraft.title);
});
