import assert from "node:assert/strict";
import {
  getStarGateState,
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
markStarRedirect(storage, key, "https://github.com/example/repo", 100);
assert.equal(getStarGateState(storage, key), "redirected");
markStarVerified(storage, key, 200);
assert.equal(getStarGateState(storage, key), "verified");

setPendingAction(storage, "pending", "generate");
assert.equal(getPendingAction(storage, "pending"), "generate");

console.log("gate behavior tests passed");
