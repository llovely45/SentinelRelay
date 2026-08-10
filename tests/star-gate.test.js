import test from "node:test";
import assert from "node:assert/strict";
import {
  getPendingAction,
  getStarGateState,
  markStarRedirect,
  setPendingAction
} from "../deploy/gate.js";
import { createMemoryStorage } from "./test-helpers.js";

const STAR_KEY = "sentinelrelay_star_redirected_v1";
const PENDING_KEY = "sentinelrelay_pending_action_v1";

test("Star gate starts new and records a redirect payload", () => {
  const storage = createMemoryStorage();
  assert.equal(getStarGateState(storage, STAR_KEY), "new");

  markStarRedirect(storage, STAR_KEY, "https://github.com/llovely45/SentinelRelay", 1700000000000);

  assert.equal(getStarGateState(storage, STAR_KEY), "redirected");
  assert.deepEqual(JSON.parse(storage.getItem(STAR_KEY)), {
    redirectedAt: 1700000000000,
    repoUrl: "https://github.com/llovely45/SentinelRelay"
  });
});

test("malformed Star records are treated as new and storage failures never escape", () => {
  const storage = createMemoryStorage({ [STAR_KEY]: "not-json" });
  assert.equal(getStarGateState(storage, STAR_KEY), "new");

  const failingStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    }
  };
  assert.equal(getStarGateState(failingStorage, STAR_KEY), "new");
  assert.doesNotThrow(() => markStarRedirect(failingStorage, STAR_KEY, "https://example.com", 1));
});

test("pending actions are stored as an action-only JSON record", () => {
  const storage = createMemoryStorage();
  assert.equal(getPendingAction(storage, PENDING_KEY), null);

  setPendingAction(storage, PENDING_KEY, "add-label");

  assert.equal(getPendingAction(storage, PENDING_KEY), "add-label");
  assert.deepEqual(JSON.parse(storage.getItem(PENDING_KEY)), { action: "add-label" });
});

test("malformed or unavailable pending-action records resolve to null", () => {
  const storage = createMemoryStorage({ [PENDING_KEY]: "{}" });
  assert.equal(getPendingAction(storage, PENDING_KEY), null);
  assert.doesNotThrow(() => setPendingAction({ setItem() { throw new Error("quota"); } }, PENDING_KEY, "x"));
  assert.equal(getPendingAction({ getItem() { throw new Error("blocked"); } }, PENDING_KEY), null);
});
