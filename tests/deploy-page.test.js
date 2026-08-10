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

test("Star gate closes without referencing an undefined result", () => {
  const html = readFileSync(new URL("../deploy/index.html", import.meta.url), "utf8");
  const closeGate = html.match(/function closeStarGate\(\)[\s\S]*?\n    \}/u)?.[0] || "";
  assert.doesNotMatch(closeGate, /return result/);
});
