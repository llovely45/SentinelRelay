import test from "node:test";
import assert from "node:assert/strict";
import { buildFingerprintMeta, createStore } from "../worker/worker.js";
import { createFakeD1 } from "./fake-d1.js";

test("ensureSchema is idempotent and session is single-use", async () => {
  const db = createFakeD1();
  const store = createStore(db);
  await store.ensureSchema();
  await store.ensureSchema();
  const user = await store.upsertTelegramUser({ id: 42, first_name: "A" });
  const session = await store.createVerificationSession(user.user_id, 30);
  assert.equal((await store.getSession(session.session_id)).status, "pending");
  const claimToken = await store.claimVerificationSession(42, session.session_id);
  await store.markVerified(42, 1001, session.session_id, claimToken);
  assert.equal((await store.getSession(session.session_id)).status, "passed");
  assert.equal(await store.getLatestPendingSessionForUser(42), null);
});

test("user state, prompts, fingerprints, and session transitions round-trip", async () => {
  const store = createStore(createFakeD1());
  await store.ensureSchema();

  const first = await store.upsertTelegramUser({
    id: 7,
    username: "alice",
    first_name: "Alice",
    last_name: "A",
    language_code: "en"
  });
  assert.equal(first.user_id, 7);
  assert.equal(first.is_verified, 0);
  assert.equal(first.is_blacklisted, 0);

  await store.setVerificationPrompt(7, 99, 123);
  assert.deepEqual(
    (await store.getUser(7)).verification_prompt_chat_id,
    99
  );
  assert.equal((await store.getUser(7)).verification_prompt_message_id, 123);
  await store.clearVerificationPrompt(7);
  assert.equal((await store.getUser(7)).verification_prompt_chat_id, null);

  const meta = await buildFingerprintMeta({
    system: "Linux",
    publicIpInfo: { ip: "8.8.8.8", asn: "15169", organization: "Google" },
    webrtcIpInfos: [],
    fingerprint: { canvas: "canvas" }
  });
  const withFingerprint = await store.setLatestFingerprint(7, meta);
  assert.equal(withFingerprint.latest_fingerprint_id, meta.id);
  assert.deepEqual(withFingerprint.latest_fingerprint_meta, meta);

  const session = await store.createVerificationSession(7, 30);
  assert.equal((await store.getLatestPendingSessionForUser(7)).session_id, session.session_id);
  await store.setTopicThreadId(7, 1001);
  assert.equal((await store.getUserByThreadId(1001)).user_id, 7);
  const claimToken = await store.claimVerificationSession(7, session.session_id);
  await store.markVerified(7, 1001, session.session_id, claimToken);
  const verified = await store.getUser(7);
  assert.equal(verified.is_verified, 1);
  assert.equal(verified.topic_thread_id, 1001);
  assert.equal((await store.getSession(session.session_id)).consumed_at !== null, true);
  assert.equal(await store.getLatestPendingSessionForUser(7), null);
});

test("fingerprint label helpers provide hydration, paging, grouping, and blocking", async () => {
  const store = createStore(createFakeD1());
  await store.ensureSchema();
  await store.upsertTelegramUser({ id: 8, first_name: "B" });
  const meta = await buildFingerprintMeta({ system: "Linux", publicIpInfo: { ip: "8.8.4.4" }, fingerprint: {} });

  const one = await store.createFingerprintLabel({
    labelName: "office",
    note: "first",
    fingerprintMeta: meta,
    sourceUserId: 8,
    createdByUserId: 99
  });
  const two = await store.createFingerprintLabel({
    labelName: "office",
    note: "second",
    fingerprintMeta: meta,
    sourceUserId: 8,
    createdByUserId: 99,
    isBlocked: true
  });
  await store.createFingerprintLabel({
    labelName: "home",
    fingerprintMeta: meta,
    sourceUserId: 8,
    createdByUserId: 99
  });

  assert.equal(one.id < two.id, true);
  assert.equal((await store.listFingerprintLabels()).length, 3);
  assert.equal((await store.listBlockedFingerprintLabels()).length, 1);
  assert.equal((await store.getFingerprintLabelById(one.id)).fingerprint_meta.id, meta.id);
  assert.equal((await store.getFingerprintLabelsByName("office")).length, 2);

  const page = await store.getFingerprintLabelsPageByUserId(8, 1, 2);
  assert.equal(page.total, 3);
  assert.equal(page.totalPages, 2);
  assert.equal(page.items.length, 2);
  const names = await store.getDistinctFingerprintLabelNamesPage(1, 1);
  assert.equal(names.total, 2);
  assert.equal(names.items[0].label_name, "home");
  assert.equal(names.items[0].total, 1);

  await store.setFingerprintLabelBlockedByName("home", true);
  assert.equal((await store.listBlockedFingerprintLabels()).length, 2);
  await store.deleteFingerprintLabelById(one.id);
  assert.equal((await store.getFingerprintLabelById(one.id)), null);
});

test("blacklist, admin action, and runtime setting methods use persisted state", async () => {
  const store = createStore(createFakeD1());
  await store.ensureSchema();
  await store.upsertTelegramUser({ id: 9, first_name: "C" });
  const session = await store.createVerificationSession(9, 30);
  await store.blacklistUser(9, session.session_id, "blocked");
  assert.equal((await store.getUser(9)).is_blacklisted, 1);
  assert.equal((await store.getSession(session.session_id)).status, "failed");
  assert.equal((await store.getSession(session.session_id)).fail_reason, "blocked");
  await store.clearBlacklist(9);
  await store.approveUser(9);
  assert.equal((await store.getUser(9)).is_verified, 1);
  assert.equal((await store.getUser(9)).is_blacklisted, 0);
  await store.cancelVerification(9);
  assert.equal((await store.getUser(9)).is_verified, 0);
  await store.blacklistUserDirect(9);
  assert.equal((await store.getUser(9)).is_blacklisted, 1);

  await store.upsertPendingAdminAction({
    threadId: 100,
    adminId: 200,
    userId: 9,
    action: "label",
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  assert.equal((await store.getPendingAdminAction(100, 200)).action, "label");
  await store.deletePendingAdminAction(100, 200);
  assert.equal(await store.getPendingAdminAction(100, 200), null);
  await store.setRuntimeSetting("webhook_digest", "abc");
  assert.equal(await store.getRuntimeSetting("webhook_digest"), "abc");
  await store.setRuntimeSetting("webhook_digest", "def");
  assert.equal(await store.getRuntimeSetting("webhook_digest"), "def");
});

test("fake D1 rejects a prepared statement with an unbound value", async () => {
  const db = createFakeD1();
  await assert.rejects(() => db.prepare("SELECT ?").first(), /unbound value/);
});

test("expired sessions are not pending and cannot be consumed", async () => {
  const store = createStore(createFakeD1());
  await store.ensureSchema();
  await store.upsertTelegramUser({ id: 10, first_name: "Expired" });
  const session = await store.createVerificationSession(10, -1);

  assert.equal((await store.getSession(session.session_id)).status, "expired");
  assert.equal(await store.getLatestPendingSessionForUser(10), null);
  assert.equal(await store.markVerified(10, 2000, session.session_id, "expired-token"), null);
  assert.equal((await store.getUser(10)).is_verified, 0);
});

test("markVerified consumes a session exactly once under concurrent attempts", async () => {
  const store = createStore(createFakeD1());
  await store.ensureSchema();
  await store.upsertTelegramUser({ id: 11, first_name: "Single use" });
  const session = await store.createVerificationSession(11, 30);
  const claimToken = await store.claimVerificationSession(11, session.session_id);

  const results = await Promise.all([
    store.markVerified(11, 3001, session.session_id, claimToken),
    store.markVerified(11, 3002, session.session_id, claimToken)
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.getSession(session.session_id)).status, "passed");
  assert.equal([3001, 3002].includes((await store.getUser(11)).topic_thread_id), true);
  assert.equal(await store.markVerified(11, 3999, session.session_id, claimToken), null);
  assert.notEqual((await store.getUser(11)).topic_thread_id, 3999);
});

test("null topic thread lookups follow SQL NULL semantics", async () => {
  const store = createStore(createFakeD1());
  await store.ensureSchema();
  await store.upsertTelegramUser({ id: 12, first_name: "No thread" });
  assert.equal(await store.getUserByThreadId(null), null);
});
