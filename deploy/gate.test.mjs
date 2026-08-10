import assert from "node:assert/strict";
import {
  getStarGateState,
  getStarGatePrompt,
  markStarRedirect,
  markStarVerified,
  setPendingAction,
  getPendingAction
} from "./gate.js";

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

const storage = new MemoryStorage();
const key = "gate";

assert.equal(getStarGateState(storage, key), "new");
assert.deepEqual(getStarGatePrompt("new"), { button: "点击跳转", action: "redirect" });
markStarRedirect(storage, key, "https://github.com/example/repo", 100);
assert.equal(getStarGateState(storage, key), "redirected");
assert.deepEqual(getStarGatePrompt("redirected"), { button: "我已验证", action: "verify" });
markStarVerified(storage, key, 200);
assert.equal(getStarGateState(storage, key), "verified");
assert.deepEqual(getStarGatePrompt("verified"), { button: "", action: "pass" });

setPendingAction(storage, "pending", "generate");
assert.equal(getPendingAction(storage, "pending"), "generate");

console.log("gate behavior tests passed");
