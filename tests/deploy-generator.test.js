import test from "node:test";
import assert from "node:assert/strict";
import { replaceWorkerPlaceholders, validateDeployConfig } from "../deploy/generator.js";

test("replaceWorkerPlaceholders JSON-escapes credentials and removes every marker", () => {
  const template = 'const c = { token: "__TG_BOT_TOKEN__", group: "__TG_GROUP_ID__" };';
  const output = replaceWorkerPlaceholders(template, {
    TG_BOT_TOKEN: '123:ab"\\cd',
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

test("validateDeployConfig accepts only an HTTPS origin for APP_BASE_URL", () => {
  const config = {
    TG_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyzABCDE",
    TG_GROUP_ID: "-100123",
    APP_BASE_URL: "https://worker.example",
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET_KEY: "secret-key",
    TG_WEBHOOK_SECRET: "a-webhook-secret-long-enough",
    VERIFICATION_TTL_MINUTES: "30",
    STUN_SERVER_URL: "stun:stun.example:3478"
  };
  for (const value of [
    "https://worker.example/path",
    "https://worker.example?next=/path",
    "https://worker.example#fragment"
  ]) {
    const result = validateDeployConfig({ ...config, APP_BASE_URL: value });
    assert.equal(result.ok, false, value);
    assert.deepEqual(result.errors, ["APP_BASE_URL 必须使用 HTTPS 且不能带末尾斜杠"], value);
  }
  assert.equal(validateDeployConfig(config).ok, true);
});

test("validateDeployConfig rejects HTTPS origins containing userinfo", () => {
  const config = {
    TG_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyzABCDE",
    TG_GROUP_ID: "-100123",
    APP_BASE_URL: "https://user:password@worker.example",
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET_KEY: "secret-key",
    TG_WEBHOOK_SECRET: "a-webhook-secret-long-enough",
    VERIFICATION_TTL_MINUTES: "30",
    STUN_SERVER_URL: "stun:stun.example:3478"
  };
  const result = validateDeployConfig(config);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["APP_BASE_URL 必须使用 HTTPS 且不能带末尾斜杠"]);
});

test("validateDeployConfig enforces Telegram webhook secret characters and length", () => {
  const config = {
    TG_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyzABCDE",
    TG_GROUP_ID: "-100123",
    APP_BASE_URL: "https://worker.example",
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET_KEY: "secret-key",
    TG_WEBHOOK_SECRET: "a-webhook-secret-long-enough",
    VERIFICATION_TTL_MINUTES: "30",
    STUN_SERVER_URL: "stun:stun.example:3478"
  };
  for (const value of [
    "secret with spaces",
    "secret.with.punctuation",
    "x".repeat(257)
  ]) {
    const result = validateDeployConfig({ ...config, TG_WEBHOOK_SECRET: value });
    assert.equal(result.ok, false, value);
    assert.deepEqual(result.errors, ["TG_WEBHOOK_SECRET 至少需要 16 个字符"], value);
  }
  assert.equal(validateDeployConfig({ ...config, TG_WEBHOOK_SECRET: "A-z_09-123456789" }).ok, true);
});
