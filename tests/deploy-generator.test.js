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
