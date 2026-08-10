# SentinelRelay Cloudflare Worker Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Build a dependency-free Cloudflare Worker template plus a static browser generator that ports the tg-bot Telegram relay to D1 and lets users validate configuration and copy the generated worker.js.

**Architecture:** worker/worker.js is the only runtime artifact and contains quoted configuration markers that the browser replaces with JSON-safe values. deploy/index.html owns the form, local Star reminder gate, Telegram API checks, and clipboard output; small same-folder modules hold pure generator/gate functions so they can be tested without a browser. The Worker uses raw Telegram Bot API calls, D1-backed state, and fetch-based HTTP routes; every cross-request state transition is persisted in D1.

**Tech Stack:** Cloudflare Workers module syntax, Cloudflare D1, Telegram Bot API over fetch, Cloudflare Turnstile, browser Web APIs (localStorage, Clipboard API, WebRTC), Node.js built-in node:test for pure/integration tests.

## Global Constraints

- The Worker has no npm/runtime dependencies and exports default { fetch }.
- The only required Cloudflare binding is a D1 database named DB.
- The generator never uploads or persists Telegram/Turnstile credentials or generated code.
- Configuration markers are __TG_BOT_TOKEN__, __TG_GROUP_ID__, __APP_BASE_URL__, __TURNSTILE_SITE_KEY__, __TURNSTILE_SECRET_KEY__, __TG_WEBHOOK_SECRET__, __VERIFICATION_TTL_MINUTES__, and __STUN_SERVER_URL__.
- The Star flow is a local reminder gate, not GitHub OAuth or authoritative Star verification.
- Existing README.md and go.mod working-tree changes are user-owned; do not revert or include them in feature commits.
- Every implementation task follows RED -> GREEN -> REFACTOR and ends with a focused commit.

---

### Task 1: Add the test harness and pure deployment-generator contracts

**Files:**
- Create: package.json
- Create: deploy/generator.js
- Create: deploy/gate.js
- Create: tests/test-helpers.js
- Create: tests/deploy-generator.test.js
- Create: tests/star-gate.test.js

**Interfaces:**
- deploy/generator.js exports validateDeployConfig(values) -> { ok: boolean, errors: string[] } and replaceWorkerPlaceholders(template, values) -> string.
- deploy/gate.js exports getStarGateState(storage, key) -> "new" | "redirected", markStarRedirect(storage, key, repoUrl, now) -> void, and getPendingAction(storage, key) / setPendingAction(storage, key, action).
- tests/test-helpers.js exports createMemoryStorage(), fakeTelegram(), fakeStoreWithExpiredSession(), createTestEnv(), and fakeExecutionContext() for later test files; each helper is deterministic and contains no network calls.
- package.json exposes npm test as node --test and sets type to module.

- [ ] Step 1: Write the failing generator tests

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { replaceWorkerPlaceholders, validateDeployConfig } from "../deploy/generator.js";

test("replaceWorkerPlaceholders JSON-escapes credentials and removes every marker", () => {
  const template = 'const c = { token: "__TG_BOT_TOKEN__", group: "__TG_GROUP_ID__" };';
  const output = replaceWorkerPlaceholders(template, {
    TG_BOT_TOKEN: '123:ab"\\\\cd',
    TG_GROUP_ID: "-100123"
  });
  assert.match(output, /123:ab/);
  assert.doesNotMatch(output, /__TG_(BOT_TOKEN|GROUP_ID)__/);
  assert.doesNotThrow(() => new Function(output));
});

test("validateDeployConfig rejects invalid URL, group and secret", () => {
  const result = validateDeployConfig({
    TG_BOT_TOKEN: "bad",
    TG_GROUP_ID: "chat",
    APP_BASE_URL: "http://worker.example",
    TURNSTILE_SITE_KEY: "",
    TURNSTILE_SECRET_KEY: "secret",
    TG_WEBHOOK_SECRET: "short",
    VERIFICATION_TTL_MINUTES: "2",
    STUN_SERVER_URL: "https://stun.example"
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "TG_BOT_TOKEN 格式或长度无效",
    "TG_GROUP_ID 必须是数字",
    "APP_BASE_URL 必须使用 HTTPS 且不能带末尾斜杠",
    "TURNSTILE_SITE_KEY 不能为空",
    "TG_WEBHOOK_SECRET 至少需要 16 个字符",
    "VERIFICATION_TTL_MINUTES 必须是 5 到 1440 之间的整数",
    "STUN_SERVER_URL 必须以 stun: 开头"
  ]);
});
~~~

- [ ] Step 2: Run the focused tests and confirm the expected missing-module failure

Run: npm test -- tests/deploy-generator.test.js

Expected: FAIL because deploy/generator.js is not defined yet.

- [ ] Step 3: Write the minimal generator and gate modules

replaceWorkerPlaceholders must replace only quoted marker strings using JSON.stringify(String(value)); reject a template if any __<uppercase marker>__ remains. validateDeployConfig must produce the exact Chinese messages asserted above and additionally validate non-empty Turnstile fields, HTTPS URL, numeric group ID, 5–1440 TTL, 16-character webhook secret, and stun: URL.

The gate module must use the supplied Storage-like object and store only JSON { redirectedAt, repoUrl } under the Star key and { action } under the pending-action key. It must return "new" when the key is absent or malformed and never throw on storage quota/security errors.

Implement tests/test-helpers.js with an in-memory Storage map, a fake Telegram client that records calls, a store returning an expired session, a test environment containing a fake D1 and Telegram call log, and an execution context whose waitUntil records promises.

- [ ] Step 4: Run focused tests and refactor only after green

Run: npm test -- tests/deploy-generator.test.js tests/star-gate.test.js

Expected: PASS with no warnings. Refactor shared marker/error constants only while the tests remain green.

- [ ] Step 5: Commit the test harness and pure contracts

~~~bash
git add package.json deploy/generator.js deploy/gate.js tests/test-helpers.js tests/deploy-generator.test.js tests/star-gate.test.js
git commit -m "test: establish generator and Star gate contracts"
~~~

### Task 2: Implement the D1 schema, repository, and fingerprint primitives

**Files:**
- Modify: worker/worker.js
- Create: tests/fake-d1.js
- Create: tests/d1-store.test.js
- Create: tests/fingerprint.test.js

**Interfaces:**
- worker/worker.js exports SCHEMA_SQL, createStore(db), buildFingerprintMeta(input), computeFingerprintSimilarity(current, labeled), findSimilarFingerprintLabels(current, labels, threshold), normalizePublicIpList(value), and escapeHtml(value) for tests; production still exports default { fetch }.
- createStore(db) exposes ensureSchema(), upsertTelegramUser(user), getUser(userId), getUserByThreadId(threadId), createVerificationSession(userId, ttlMinutes), getSession(sessionId), getLatestPendingSessionForUser(userId), setVerificationPrompt(userId, chatId, messageId), clearVerificationPrompt(userId), setTopicThreadId(userId, threadId), setLatestFingerprint(userId, meta), markVerified(userId, threadId, sessionId), approveUser(userId), cancelVerification(userId), blacklistUser(userId, sessionId, reason), blacklistUserDirect(userId), clearBlacklist(userId), createFingerprintLabel(input), listFingerprintLabels(), listBlockedFingerprintLabels(), getFingerprintLabelsPageByUserId(userId, page, pageSize), getDistinctFingerprintLabelNamesPage(page, pageSize), getFingerprintLabelById(id), getFingerprintLabelsByName(name), deleteFingerprintLabelById(id), setFingerprintLabelBlockedByName(name, blocked), upsertPendingAdminAction(input), getPendingAdminAction(threadId, adminId), deletePendingAdminAction(threadId, adminId), getRuntimeSetting(key), and setRuntimeSetting(key, value).

- [ ] Step 1: Write the failing D1 and fingerprint tests

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, buildFingerprintMeta, computeFingerprintSimilarity } from "../worker/worker.js";
import { createFakeD1 } from "./fake-d1.js";

test("ensureSchema is idempotent and session is single-use", async () => {
  const db = createFakeD1();
  const store = createStore(db);
  await store.ensureSchema();
  await store.ensureSchema();
  const user = await store.upsertTelegramUser({ id: 42, first_name: "A" });
  const session = await store.createVerificationSession(user.user_id, 30);
  assert.equal((await store.getSession(session.session_id)).status, "pending");
  await store.markVerified(42, 1001, session.session_id);
  assert.equal((await store.getSession(session.session_id)).status, "passed");
  assert.equal(await store.getLatestPendingSessionForUser(42), null);
});

test("fingerprint metadata is stable and exact data scores 100", async () => {
  const input = { system: "macOS", publicIpInfo: { ip: "203.0.113.10" }, webrtcIpInfos: [], fingerprint: { canvas: "c", audio: "a" } };
  const left = await buildFingerprintMeta(input);
  const right = await buildFingerprintMeta(input);
  assert.equal(left.id, right.id);
  assert.equal(computeFingerprintSimilarity(left, right), 100);
});
~~~

- [ ] Step 2: Run the tests and confirm they fail for missing Worker exports

Run: npm test -- tests/d1-store.test.js tests/fingerprint.test.js

Expected: FAIL because worker/worker.js and tests/fake-d1.js do not yet provide the contracts.

- [ ] Step 3: Implement schema, D1 adapter, and pure fingerprint code

Create the five tables from the design (users, verification_sessions, fingerprint_labels, pending_admin_actions, runtime_settings) with primary keys, foreign keys, indexes, and unique topic_thread_id. Use bound parameters for every value, ISO timestamps, crypto.randomUUID() for sessions, Web Crypto SHA-256 for fingerprint IDs, deterministic object-key sorting, the existing 40% network/60% device blended similarity calculation, and a threshold-based best label per name.

Implement tests/fake-d1.js as a deterministic in-memory D1 subset supporting exec, prepare().bind().run(), first(), all(), and batch() for the SQL statements used by createStore; it must throw on an unbound value so tests catch unsafe queries.

- [ ] Step 4: Run focused tests, then run the full current suite

Run: npm test -- tests/d1-store.test.js tests/fingerprint.test.js

Expected: PASS.

Run: npm test

Expected: PASS with all existing and new tests green.

- [ ] Step 5: Commit the D1 and fingerprint layer

~~~bash
git add worker/worker.js tests/fake-d1.js tests/d1-store.test.js tests/fingerprint.test.js
git commit -m "feat: add D1 store and fingerprint primitives"
~~~

### Task 3: Add the raw Telegram API client and update processing

**Files:**
- Modify: worker/worker.js
- Create: tests/telegram-api.test.js
- Create: tests/update-processing.test.js

**Interfaces:**
- createTelegramClient({ token, fetchImpl = fetch }) returns call(method, payload), getMe(), getChat(chatId), getChatMember(chatId, userId), setWebhook(url, secret), sendMessage(chatId, text, options), copyMessage(target, source, messageId, options), createForumTopic(chatId, name), answerCallbackQuery(id, text, options), editMessageText(chatId, messageId, text, options), and deleteMessage(chatId, messageId).
- processTelegramUpdate(update, { config, store, telegram }) -> Promise<void> handles private messages, group-topic messages, /admin, callback actions, pending label input, and verification prompts.

- [ ] Step 1: Write failing API and update tests

~~~js
test("Telegram client sends POST JSON and returns Telegram result", async () => {
  const calls = [];
  const telegram = createTelegramClient({
    token: "123:token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: { id: 7 } }), { status: 200 });
    }
  });
  assert.deepEqual(await telegram.getMe(), { id: 7 });
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:token/getMe");
  assert.equal(JSON.parse(calls[0].init.body).chat_id, undefined);
});
~~~

- [ ] Step 2: Run focused tests and verify the missing-client failure

Run: npm test -- tests/telegram-api.test.js tests/update-processing.test.js

Expected: FAIL because the client and update processor are not implemented.

- [ ] Step 3: Implement the API client and update processor

Use fetch with Content-Type application/json, check both HTTP status and Telegram ok, and throw normalized errors without including the token in messages. Port the existing message rules, Forum Topic creation, prompt replacement, admin checks, callback keyboard actions, label pagination, and reverse copyMessage flow. Replace the original in-memory pending mark map with pending_admin_actions D1 rows keyed by thread_id and admin_id, expiring after 10 minutes.

- [ ] Step 4: Run API/update tests and refactor after green

Run: npm test -- tests/telegram-api.test.js tests/update-processing.test.js

Expected: PASS. Refactor only duplicated Telegram payload builders and HTML/text formatters while preserving tests.

- [ ] Step 5: Commit Telegram processing

~~~bash
git add worker/worker.js tests/telegram-api.test.js tests/update-processing.test.js
git commit -m "feat: port Telegram webhook and topic relay"
~~~

### Task 4: Add verification, Turnstile, fingerprint page rendering, and IP metadata

**Files:**
- Modify: worker/worker.js
- Create: tests/verification.test.js
- Create: tests/pages.test.js

**Interfaces:**
- verifyTurnstile({ secretKey, token, remoteIp, fetchImpl = fetch }) -> Promise<{ success: boolean, ... }>.
- handleVerificationRequest(request, sessionId, { miniApp, env, store, telegram }) -> Promise<Response>.
- renderVerificationPage(options), renderMiniAppVerificationPage(options), and renderResultPage(options) -> string.
- lookupIpMetadata(ip, request, fetchImpl = fetch) -> Promise<{ ip, asn, organization } | null>.

- [ ] Step 1: Write failing verification/page tests

~~~js
test("verification page escapes site key and includes Turnstile and signal fields", () => {
  const html = renderVerificationPage({ siteKey: 'site"&', sessionId: "abc" });
  assert.match(html, /site&quot;&amp;/);
  assert.match(html, /cf-turnstile/);
  assert.match(html, /fingerprint_payload/);
  assert.match(html, /webrtc_ip/);
});

test("expired session returns 410 without calling Turnstile", async () => {
  let called = false;
  const response = await handleVerificationRequest(new Request("https://x/api"), "expired", {
    env: { TURNSTILE_FETCH: async () => { called = true; } },
    store: fakeStoreWithExpiredSession(),
    telegram: fakeTelegram()
  });
  assert.equal(response.status, 410);
  assert.equal(called, false);
});
~~~

- [ ] Step 2: Run focused tests and confirm page/handler exports are missing

Run: npm test -- tests/verification.test.js tests/pages.test.js

Expected: FAIL because the verification handlers and pages do not yet exist.

- [ ] Step 3: Implement Turnstile, browser signal collection, IP handling, and completion flow

Port the existing HTML signal collectors, but add a visible privacy notice and make all fields optional when a browser blocks a signal. Validate session status/expiry before any external call; POST form data to Turnstile; normalize the request IP and public WebRTC list; use request.cf first and a fetch-based public metadata fallback; persist the fingerprint before matching blocked labels; create a topic and notify both sides on success; mark a blocked match as failed and blacklisted.

- [ ] Step 4: Run focused and full tests

Run: npm test -- tests/verification.test.js tests/pages.test.js

Expected: PASS.

Run: npm test

Expected: PASS with no warnings.

- [ ] Step 5: Commit verification and pages

~~~bash
git add worker/worker.js tests/verification.test.js tests/pages.test.js
git commit -m "feat: add Turnstile verification pages"
~~~

### Task 5: Wire the Worker router, D1 bootstrap, and Webhook security

**Files:**
- Modify: worker/worker.js
- Create: tests/worker-router.test.js

**Interfaces:**
- export async function handleRequest(request, env, ctx) -> Promise<Response>.
- export default { fetch: handleRequest }.
- ensureWebhook(env, request, store, telegram) -> Promise<{ registered: boolean, skipped: boolean }>.

- [ ] Step 1: Write failing router/security tests

~~~js
test("health initializes D1 and registers webhook once", async () => {
  const env = createTestEnv();
  const first = await handleRequest(new Request("https://worker.example/health"), env, fakeExecutionContext());
  const second = await handleRequest(new Request("https://worker.example/health"), env, fakeExecutionContext());
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(env.telegramCalls.filter((call) => call.method === "setWebhook").length, 1);
});

test("webhook rejects an invalid Telegram secret before parsing updates", async () => {
  const response = await handleRequest(new Request("https://worker.example/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
    body: "{}"
  }), createTestEnv(), fakeExecutionContext());
  assert.equal(response.status, 403);
});
~~~

- [ ] Step 2: Run router tests and confirm the exported handler is missing/incomplete

Run: npm test -- tests/worker-router.test.js

Expected: FAIL until the Worker fetch entry, schema bootstrap, and secret check are wired.

- [ ] Step 3: Implement routing and bootstrap

Parse URL/method once, create the D1 store per request, run ensureSchema before any store access, return CORS only for verification API responses, and route the paths in the design. Store a SHA-256 digest of APP_BASE_URL + webhook path + webhook secret in runtime_settings; skip setWebhook if the digest is unchanged. Use ctx.waitUntil only for non-critical cleanup, never for the response's required D1 or Telegram result.

- [ ] Step 4: Run router and full tests

Run: npm test -- tests/worker-router.test.js

Expected: PASS.

Run: npm test

Expected: PASS.

- [ ] Step 5: Commit the Worker entry point

~~~bash
git add worker/worker.js tests/worker-router.test.js
git commit -m "feat: expose Cloudflare Worker routes"
~~~

### Task 6: Build the static deployment page, Star gate, API validation, and clipboard output

**Files:**
- Modify: deploy/index.html
- Modify: deploy/generator.js
- Modify: deploy/gate.js
- Create: deploy/README.md
- Create: tests/deploy-page.test.js

**Interfaces:**
- The page calls validateDeployConfig, getStarGateState, markStarRedirect, setPendingAction, and replaceWorkerPlaceholders from same-folder modules.
- runTelegramValidation(values) -> Promise<{ ok: boolean, bot?: object, chat?: object, error?: string }> uses POST JSON to getMe and getChat.
- copyGeneratedWorker(code) -> Promise<"clipboard" | "fallback"> copies without persistence.

- [ ] Step 1: Write failing page contract tests

~~~js
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("page contains both protected actions and Star gate labels", () => {
  const html = readFileSync(new URL("../deploy/index.html", import.meta.url), "utf8");
  assert.match(html, /API 验证/);
  assert.match(html, /生成代码/);
  assert.match(html, /立即跳转仓库/);
  assert.match(html, /我已验证/);
  assert.match(html, /sentinelrelay_star_redirected_v1/);
  assert.match(html, /复制完整代码/);
});
~~~

- [ ] Step 2: Run the page contract test and confirm the static page is missing

Run: npm test -- tests/deploy-page.test.js

Expected: FAIL because deploy/index.html is not defined.

- [ ] Step 3: Implement the page

Create a responsive Chinese deployment wizard with labeled password fields, group ID, HTTPS base URL, Turnstile keys, webhook secret, TTL, and STUN URL. The click handlers for both protected actions must call one gate function before validation/generation; the gate must show a spinner for 1000 ms, write the redirect marker before window.open, and on subsequent attempts show “我已验证”. After confirmation, validate Telegram credentials, fetch ../worker/worker.js from the same origin, replace markers, render a read-only code area, and expose a clipboard button plus a clear-result button. Do not put secrets in query parameters or localStorage.

- [ ] Step 4: Add deployment instructions and run static checks

Document that the page must be served over HTTP (for example python3 -m http.server from the repository root), that generated code is pasted into a Worker, that D1 binding name is DB, that /health must be opened once, and that Telegram group Topics/permissions and Turnstile domain configuration are required.

Run: npm test -- tests/deploy-page.test.js

Expected: PASS.

- [ ] Step 5: Commit the deployment wizard

~~~bash
git add deploy/index.html deploy/generator.js deploy/gate.js deploy/README.md tests/deploy-page.test.js
git commit -m "feat: add browser Worker generator"
~~~

### Task 7: Update project documentation and perform end-to-end verification

**Files:**
- Modify: README.md
- Modify: .gitignore
- Create: tests/security-contract.test.js

**Interfaces:**
- README explains the new worker/ and deploy/ folders, D1 binding, /health bootstrap, visible fingerprint notice, and the local-only Star reminder.
- .gitignore excludes worker.generated.js, .env, local D1 state, and test output without ignoring source templates or tests.

- [ ] Step 1: Write failing security-contract tests

~~~js
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("source tree has no real secrets and generated output is ignored", () => {
  const template = readFileSync(new URL("../worker/worker.js", import.meta.url), "utf8");
  assert.match(template, /__TG_BOT_TOKEN__/);
  assert.doesNotMatch(template, /\\b\\d{8,}:\\w{20,}\\b/);
  assert.match(readFileSync(new URL("../.gitignore", import.meta.url), "utf8"), /worker\\.generated\\.js/);
});
~~~

- [ ] Step 2: Run the security test and fix only source/config issues

Run: npm test -- tests/security-contract.test.js

Expected: FAIL until the template markers and ignore rules are present; then PASS.

- [ ] Step 3: Update README and ignore rules

Add the copy/paste deployment workflow, list every generated configuration field, explain that only D1 DB is required, document the /health bootstrap and webhook secret, and state plainly that the Star prompt is not authoritative verification. Preserve unrelated user edits already present in README.md and do not restore go.mod.

- [ ] Step 4: Run the full verification suite and static syntax checks

Run: npm test

Expected: all tests pass with zero failures.

Run: node --check deploy/generator.js && node --check deploy/gate.js && node --check worker/worker.js

Expected: all commands exit 0.

Run: python3 -m http.server 8765 --directory . in a separate terminal, then request http://127.0.0.1:8765/deploy/index.html and confirm HTTP 200; stop the server after the check.

- [ ] Step 5: Review the final diff and commit documentation/verification changes

~~~bash
git diff --check
git status --short
git add README.md .gitignore tests/security-contract.test.js
git commit -m "docs: document Worker deployment workflow"
~~~

Do not stage the pre-existing deletion/modification unless it is intentionally part of the user's current changes; if the file list shows those paths already modified, leave them unstaged and report them separately.
