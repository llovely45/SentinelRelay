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

test("verification API responses include CORS while other routes do not", async () => {
  const env = createTestEnv({ DB: createFakeD1() });
  const options = { method: "OPTIONS", headers: { origin: "https://example.test" } };
  const response = await handleRequest(new Request("https://worker.example/api/verify/session", options), env, fakeExecutionContext());
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const root = await handleRequest(new Request("https://worker.example/"), env, fakeExecutionContext());
  assert.equal(root.headers.get("access-control-allow-origin"), null);
});
