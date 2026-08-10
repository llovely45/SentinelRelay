import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { replaceWorkerPlaceholders } from "../deploy/generator.js";

const markerNames = [
  "TG_BOT_TOKEN",
  "TG_GROUP_ID",
  "APP_BASE_URL",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "TG_WEBHOOK_SECRET",
  "VERIFICATION_TTL_MINUTES",
  "STUN_SERVER_URL"
];

test("source tree has no real secrets and generated output is ignored", () => {
  const template = readFileSync(new URL("../worker/worker.js", import.meta.url), "utf8");
  assert.match(template, /__TG_BOT_TOKEN__/);
  assert.doesNotMatch(template, /\b\d{8,}:\w{20,}\b/);
  assert.match(readFileSync(new URL("../.gitignore", import.meta.url), "utf8"), /worker\.generated\.js/);
});

test("generated marker replacement embeds runtime configuration when only D1 is bound", async () => {
  const template = readFileSync(new URL("../worker/worker.js", import.meta.url), "utf8");
  const values = {
    TG_BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
    TG_GROUP_ID: "-100123",
    APP_BASE_URL: "https://worker.example",
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET_KEY: "secret-key",
    TG_WEBHOOK_SECRET: "a-webhook-secret-long-enough",
    VERIFICATION_TTL_MINUTES: "30",
    STUN_SERVER_URL: "stun:stun.example:3478"
  };
  const generated = replaceWorkerPlaceholders(template, values);

  for (const marker of markerNames) assert.doesNotMatch(generated, new RegExp(`__${marker}__`));
  assert.match(generated, /const EMBEDDED_CONFIG\s*=\s*\{/);
  assert.match(generated, /TG_BOT_TOKEN:\s*"123456789:abcdefghijklmnopqrstuvwxyzABCDE"/);
  assert.match(generated, /STUN_SERVER_URL:\s*"stun:stun\.example:3478"/);
  assert.match(generated, /EMBEDDED_CONFIG_ALIASES/);
  assert.match(generated, /CONFIG\[embeddedName\]/);

  const module = await import(`data:text/javascript,${encodeURIComponent(generated)}`);
  const db = {
    async exec() { return { success: true }; },
    prepare() {
      const statement = {
        bind() { return statement; },
        async run() { return { success: true }; },
        async first() { return null; },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };
  const pageResponse = await module.handleRequest(
    new Request("https://worker.example/miniapp"),
    { DB: db }
  );
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /site-key/);
  assert.match(page, /stun:stun\.example:3478/);

  let webhookArgs;
  const store = {
    async getRuntimeSetting() { return null; },
    async setRuntimeSetting() { return true; }
  };
  await module.ensureWebhook({ DB: {} }, new Request("https://ignored.example/health"), store, {
    async setWebhook(...args) { webhookArgs = args; }
  });
  assert.deepEqual(webhookArgs, [
    "https://worker.example/telegram/webhook",
    "a-webhook-secret-long-enough"
  ]);
});
