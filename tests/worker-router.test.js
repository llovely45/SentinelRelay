import test from "node:test";
import assert from "node:assert/strict";
import { ensureWebhook, handleRequest } from "../worker/worker.js";
import { createFakeD1 } from "./fake-d1.js";
import { createTestEnv, fakeExecutionContext } from "./test-helpers.js";

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

test("health stores a webhook digest and skips unchanged registration", async () => {
  const env = createTestEnv({ DB: createFakeD1(), telegram: undefined });
  const calls = [];
  const telegram = {
    async setWebhook(...args) { calls.push(args); return true; }
  };
  const store = {
    async getRuntimeSetting() { return null; },
    async setRuntimeSetting(_key, value) { calls.push(["digest", value]); return value; }
  };
  const result = await ensureWebhook(env, new Request("https://worker.example/health"), store, telegram);
  assert.deepEqual(result, { registered: true, skipped: false });
  assert.equal(calls.filter(([first]) => first === "digest").length, 1);
});

test("a persisted webhook digest change overrides the isolate cache", async () => {
  const env = {
    DB: {},
    APP_BASE_URL: "https://worker.example",
    TG_WEBHOOK_SECRET: "a-webhook-secret-long-enough"
  };
  const calls = [];
  let persisted = null;
  let reads = 0;
  const store = {
    async getRuntimeSetting() {
      reads += 1;
      return persisted;
    },
    async setRuntimeSetting(_key, value) {
      persisted = value;
      return value;
    }
  };
  const telegram = {
    async setWebhook(...args) { calls.push(args); return true; }
  };
  const request = new Request("https://worker.example/health");

  await ensureWebhook(env, request, store, telegram);
  assert.equal(calls.length, 1);

  persisted = "stale-digest-from-d1";
  const result = await ensureWebhook(env, request, store, telegram);
  assert.deepEqual(result, { registered: true, skipped: false });
  assert.equal(calls.length, 2);
  assert.equal(reads, 2);
});

test("verification page routes reject POST without invoking validation", async () => {
  let turnstileCalls = 0;
  const env = createTestEnv({
    TURNSTILE_FETCH: async () => {
      turnstileCalls += 1;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
  });
  const verifyResponse = await handleRequest(new Request("https://worker.example/verify/session", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  }), env, fakeExecutionContext());
  const miniAppResponse = await handleRequest(new Request("https://worker.example/miniapp?startapp=session", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  }), env, fakeExecutionContext());

  assert.equal(verifyResponse.status, 405);
  assert.equal(miniAppResponse.status, 405);
  assert.equal(verifyResponse.headers.get("access-control-allow-origin"), null);
  assert.equal(miniAppResponse.headers.get("access-control-allow-origin"), null);
  assert.equal(turnstileCalls, 0);
});

test("verification API responses include CORS while other routes do not", async () => {
  const env = createTestEnv({ DB: createFakeD1() });
  const options = { method: "OPTIONS", headers: { origin: "https://example.test" } };
  const response = await handleRequest(new Request("https://worker.example/api/verify/session", options), env, fakeExecutionContext());
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const root = await handleRequest(new Request("https://worker.example/"), env, fakeExecutionContext());
  assert.equal(root.headers.get("access-control-allow-origin"), null);
});
