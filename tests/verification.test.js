import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFingerprintMeta,
  createStore,
  handleVerificationRequest,
  lookupIpMetadata,
  verifyTurnstile
} from "../worker/worker.js";
import { createFakeD1 } from "./fake-d1.js";
import { fakeStoreWithExpiredSession, fakeTelegram } from "./test-helpers.js";

function responseJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function pendingVerificationStore() {
  return {
    async getSession() {
      return {
        session_id: "session-input-limit",
        user_id: 42,
        status: "pending",
        expires_at: "2099-01-01T00:00:00.000Z",
        is_blacklisted: 0,
        is_verified: 0
      };
    }
  };
}

test("Turnstile verifier posts form data and returns the provider response", async () => {
  const calls = [];
  const result = await verifyTurnstile({
    secretKey: "secret-key",
    token: "turnstile-token",
    remoteIp: "203.0.113.10",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responseJson({ success: true });
    }
  });
  assert.deepEqual(result, { success: true });
  assert.equal(calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual([...new URLSearchParams(calls[0].init.body)], [
    ["secret", "secret-key"],
    ["response", "turnstile-token"],
    ["remoteip", "203.0.113.10"]
  ]);
});

test("expired session returns 410 without calling Turnstile", async () => {
  let called = false;
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  }), "expired", {
    env: { TURNSTILE_FETCH: async () => { called = true; } },
    store: fakeStoreWithExpiredSession(),
    telegram: fakeTelegram()
  });
  assert.equal(response.status, 410);
  assert.equal(called, false);
});

test("verification persists fingerprint before matching and completes a pending session", async () => {
  const calls = [];
  const telegram = fakeTelegram({
    createForumTopic: { message_thread_id: 77 },
    sendMessage: { message_id: 101 }
  });
  const user = {
    user_id: 42,
    username: "alice",
    first_name: "Alice",
    is_verified: 0,
    is_blacklisted: 0
  };
  const session = {
    session_id: "session-1",
    user_id: 42,
    status: "pending",
    expires_at: "2099-01-01T00:00:00.000Z",
    ...user
  };
  let latest;
  const meta = await buildFingerprintMeta({ fingerprint: { canvas: "canvas" } });
  const store = {
    async getSession() { return { ...session }; },
    async getUser() { return { ...user }; },
    async setLatestFingerprint(id, value) { calls.push(["fingerprint", id]); latest = value; },
    async listBlockedFingerprintLabels() { calls.push(["labels"]); return []; },
    async markVerified(id, threadId, sessionId) {
      calls.push(["verified", id, threadId, sessionId]);
      return { ...user, is_verified: 1, topic_thread_id: threadId };
    }
  };
  const request = new Request("https://x/api/verify/session-1", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.10" },
    body: new URLSearchParams({
      "cf-turnstile-response": "token",
      fingerprint_payload: JSON.stringify(meta.details),
      webrtc_ip: "192.168.1.1, 8.8.8.8"
    })
  });
  const response = await handleVerificationRequest(request, "session-1", {
    env: {
      TURNSTILE_SECRET_KEY: "secret",
      TURNSTILE_FETCH: async () => responseJson({ success: true }),
      IP_METADATA_FETCH: async () => responseJson({}),
      TG_GROUP_ID: "-100123"
    },
    store,
    telegram
  });
  assert.equal(response.status, 200);
  assert.ok(latest?.id);
  assert.deepEqual(calls.map((call) => call[0]), ["fingerprint", "labels", "verified"]);
  assert.equal(telegram.calls.some((call) => call.method === "createForumTopic"), true);
});

test("verification keeps a committed topic when the post-commit user readback fails", async () => {
  const db = createFakeD1();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (/^select \* from users where user_id/i.test(String(sql).replace(/\s+/g, " ").trim())) {
      const originalFirst = statement.first.bind(statement);
      statement.first = async (...args) => {
        const row = await originalFirst(...args);
        const committed = [...db.state.verification_sessions.values()].some((session) => session.status === "passed");
        if (committed) throw new Error("post-commit readback failed");
        return row;
      };
    }
    return statement;
  };
  const store = createStore(db);
  await store.ensureSchema();
  await store.upsertTelegramUser({ id: 43, first_name: "Readback" });
  const session = await store.createVerificationSession(43, 30);
  const deletedTopics = [];
  const telegram = {
    async createForumTopic() { return { message_thread_id: 9100 }; },
    async deleteForumTopic(...args) { deletedTopics.push(args); },
    async sendMessage() {}
  };
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  }), session.session_id, {
    env: {
      TG_GROUP_ID: "-100123",
      TURNSTILE_SECRET_KEY: "secret",
      TURNSTILE_FETCH: async () => responseJson({ success: true }),
      IP_METADATA_FETCH: async () => responseJson({})
    },
    store,
    telegram
  });
  assert.equal(response.status, 200);
  assert.deepEqual(deletedTopics, []);
  assert.equal((await db.state.verification_sessions.get(session.session_id)).status, "passed");
  assert.equal(db.state.users.get("43").topic_thread_id, 9100);
});

test("metadata timeout returns null without waiting for an unbounded fetch", async () => {
  const started = Date.now();
  const result = await lookupIpMetadata("8.8.8.8", {}, async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }), { timeoutMs: 5 });
  assert.equal(result, null);
  assert.ok(Date.now() - started < 1000);
  const jsonResult = await lookupIpMetadata("8.8.4.4", {}, async () => ({
    ok: true,
    status: 200,
    async json() { return new Promise(() => {}); }
  }), { timeoutMs: 5 });
  assert.equal(jsonResult, null);
});

test("verification rejects an oversized declared request before reading the form", async () => {
  let formRead = false;
  const request = new Request("https://x/api", {
    method: "POST",
    headers: { "content-length": String(128 * 1024 + 1) },
    body: "ignored"
  });
  request.formData = async () => {
    formRead = true;
    return new FormData();
  };
  const response = await handleVerificationRequest(request, "session-input-limit", {
    store: pendingVerificationStore(),
    telegram: fakeTelegram()
  });
  assert.equal(response.status, 413);
  assert.equal(formRead, false);
});

test("verification rejects oversized raw WebRTC input before Turnstile", async () => {
  let turnstileCalls = 0;
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({
      "cf-turnstile-response": "token",
      webrtc_ip: "8.8.8.8," + "x".repeat(5000)
    })
  }), "session-input-limit", {
    env: {
      TURNSTILE_FETCH: async () => { turnstileCalls += 1; return responseJson({ success: true }); }
    },
    store: pendingVerificationStore(),
    telegram: fakeTelegram()
  });
  assert.equal(response.status, 413);
  assert.equal(turnstileCalls, 0);
});

test("verification rejects more than eight valid WebRTC IPs before metadata lookup", async () => {
  let turnstileCalls = 0;
  let metadataCalls = 0;
  const ips = Array.from({ length: 9 }, (_value, index) => `8.8.8.${index + 1}`).join(",");
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({
      "cf-turnstile-response": "token",
      webrtc_ip: ips
    })
  }), "session-input-limit", {
    env: {
      TURNSTILE_FETCH: async () => { turnstileCalls += 1; return responseJson({ success: true }); },
      IP_METADATA_FETCH: async () => { metadataCalls += 1; return responseJson({}); }
    },
    store: pendingVerificationStore(),
    telegram: fakeTelegram()
  });
  assert.equal(response.status, 413);
  assert.equal(turnstileCalls, 0);
  assert.equal(metadataCalls, 0);
});

test("verification rejects oversized and deeply wide fingerprint payloads before Turnstile", async () => {
  for (const fingerprint of [
    { canvas: "x".repeat(70 * 1024) },
    { browser: { userAgent: "x".repeat(5000) } }
  ]) {
    let turnstileCalls = 0;
    const response = await handleVerificationRequest(new Request("https://x/api", {
      method: "POST",
      body: new URLSearchParams({
        "cf-turnstile-response": "token",
        fingerprint_payload: JSON.stringify(fingerprint)
      })
    }), "session-input-limit", {
      env: {
        TURNSTILE_FETCH: async () => { turnstileCalls += 1; return responseJson({ success: true }); }
      },
      store: pendingVerificationStore(),
      telegram: fakeTelegram()
    });
    assert.equal(response.status, 413);
    assert.equal(turnstileCalls, 0);
  }
});

test("D1 verification claim is single-use and releasable", async () => {
  const store = createStore(createFakeD1());
  await store.ensureSchema();
  await store.upsertTelegramUser({ id: 45, first_name: "Claim" });
  const session = await store.createVerificationSession(45, 30);
  const firstToken = await store.claimVerificationSession(45, session.session_id);
  assert.equal(typeof firstToken, "string");
  assert.equal(await store.claimVerificationSession(45, session.session_id), false);
  assert.equal(await store.releaseVerificationSession(45, session.session_id, firstToken), true);
  assert.equal(typeof await store.claimVerificationSession(45, session.session_id), "string");
});

test("stale verification releases cannot clear a newer takeover lease", async () => {
  const store = createStore(createFakeD1());
  await store.ensureSchema();
  await store.upsertTelegramUser({ id: 46, first_name: "Lease owner" });
  const session = await store.createVerificationSession(46, 30);
  const firstToken = await store.claimVerificationSession(46, session.session_id, 1);
  assert.equal(typeof firstToken, "string");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondToken = await store.claimVerificationSession(46, session.session_id, 300_000);
  assert.equal(typeof secondToken, "string");
  assert.notEqual(secondToken, firstToken);
  assert.equal(await store.releaseVerificationSession(46, session.session_id, firstToken), false);
  assert.equal(await store.releaseVerificationSession(46, session.session_id, secondToken), true);
});

test("stale verification lease cannot mark a session after takeover", async () => {
  const store = createStore(createFakeD1());
  await store.ensureSchema();
  await store.upsertTelegramUser({ id: 47, first_name: "Stale marker" });
  const session = await store.createVerificationSession(47, 30);
  const firstToken = await store.claimVerificationSession(47, session.session_id, 1);
  assert.equal(typeof firstToken, "string");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondToken = await store.claimVerificationSession(47, session.session_id, 300_000);
  assert.equal(typeof secondToken, "string");
  assert.notEqual(secondToken, firstToken);

  const stale = await store.markVerified(47, 9001, session.session_id, firstToken);
  assert.equal(stale, null);
  assert.equal((await store.getUser(47)).is_verified, 0);
  assert.equal((await store.getUser(47)).topic_thread_id, null);

  const current = await store.markVerified(47, 9002, session.session_id, secondToken);
  assert.equal(current.topic_thread_id, 9002);
});

test("concurrent verification claims a session before creating a topic", async () => {
  const user = { user_id: 42, first_name: "Concurrent", is_verified: 0, is_blacklisted: 0 };
  const session = { session_id: "race", user_id: 42, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", ...user };
  let claims = 0;
  let topics = 0;
  let messages = 0;
  const store = {
    async getSession() { return { ...session }; },
    async setLatestFingerprint() {},
    async listBlockedFingerprintLabels() { return []; },
    async getUser() { return { ...user }; },
    async claimVerificationSession() {
      const winner = claims++ === 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return winner;
    },
    async markVerified() { return { ...user, is_verified: 1, topic_thread_id: 77 }; }
  };
  const telegram = {
    async createForumTopic() {
      topics += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { message_thread_id: 77 };
    },
    async sendMessage() { messages += 1; }
  };
  const env = {
    TG_GROUP_ID: "-100123",
    TURNSTILE_SECRET_KEY: "secret",
    TURNSTILE_FETCH: async () => responseJson({ success: true }),
    IP_METADATA_FETCH: async () => responseJson({})
  };
  const makeRequest = () => new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  });
  const responses = await Promise.all([
    handleVerificationRequest(makeRequest(), "race", { env, store, telegram }),
    handleVerificationRequest(makeRequest(), "race", { env, store, telegram })
  ]);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 1);
  assert.equal(topics, 1);
  assert.equal(messages, 2);
});

test("stale processing lease is recoverable while an active lease is retryable", async () => {
  const user = { user_id: 48, first_name: "Lease", is_verified: 0, is_blacklisted: 0 };
  const base = { session_id: "lease", user_id: 48, status: "processing", expires_at: "2099-01-01T00:00:00.000Z", ...user };
  let claimCalls = 0;
  const store = {
    async getSession() { return { ...base, consumed_at: claimCalls === 0 ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" }; },
    async setLatestFingerprint() {},
    async listBlockedFingerprintLabels() { return []; },
    async getUser() { return { ...user }; },
    async claimVerificationSession() { claimCalls += 1; return true; },
    async markVerified() { return { ...user, is_verified: 1, topic_thread_id: 80 }; }
  };
  const telegram = { async createForumTopic() { return { message_thread_id: 80 }; }, async sendMessage() {} };
  const env = { TG_GROUP_ID: "-100123", TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }), IP_METADATA_FETCH: async () => responseJson({}) };
  const makeRequest = () => new Request("https://x/api", { method: "POST", body: new URLSearchParams({ "cf-turnstile-response": "token" }) });
  const recovered = await handleVerificationRequest(makeRequest(), "lease", { env, store, telegram });
  assert.equal(recovered.status, 200);

  const activeStore = {
    async getSession() { return { ...base, consumed_at: "2099-01-01T00:00:00.000Z" }; },
    async claimVerificationSession() { throw new Error("claim must not be reached for active leases"); }
  };
  let turnstileCalled = false;
  const active = await handleVerificationRequest(makeRequest(), "lease", {
    env: { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => { turnstileCalled = true; } },
    store: activeStore,
    telegram
  });
  assert.equal(active.status, 409);
  assert.equal(turnstileCalled, false);
});

test("D1 failure after Turnstile returns a safe result instead of rejecting", async () => {
  const session = { session_id: "d1-error", user_id: 49, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", is_verified: 0, is_blacklisted: 0 };
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  }), "d1-error", {
    env: { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }), IP_METADATA_FETCH: async () => responseJson({}) },
    store: {
      async getSession() { return { ...session }; },
      async setLatestFingerprint() { throw new Error("database secret detail"); }
    },
    telegram: fakeTelegram()
  });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /database secret detail/);
});

test("a newly-created topic is deleted after completion failure and recreated on retry", async () => {
  const session = { session_id: "reuse-topic", user_id: 51, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", is_verified: 0, is_blacklisted: 0 };
  let topicCalls = 0;
  let attempts = 0;
  const deletedTopics = [];
  let setTopicCalls = 0;
  const store = {
    async getSession() { return { ...session }; },
    async setLatestFingerprint() {},
    async listBlockedFingerprintLabels() { return []; },
    async getUser() { return { ...session, topic_thread_id: null }; },
    async setTopicThreadId() { setTopicCalls += 1; },
    async claimVerificationSession() { return true; },
    async releaseVerificationSession() {},
    async markVerified() {
      attempts += 1;
      if (attempts === 1) throw new Error("transient database failure");
      return { ...session, is_verified: 1, topic_thread_id: 82 };
    }
  };
  const telegram = {
    async createForumTopic() { topicCalls += 1; return { message_thread_id: 82 }; },
    async sendMessage() {},
    async deleteForumTopic(...args) { deletedTopics.push(args); }
  };
  const env = { TG_GROUP_ID: "-100123", TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }), IP_METADATA_FETCH: async () => responseJson({}) };
  const request = () => new Request("https://x/api", { method: "POST", body: new URLSearchParams({ "cf-turnstile-response": "token" }) });
  const first = await handleVerificationRequest(request(), "reuse-topic", { env, store, telegram });
  const second = await handleVerificationRequest(request(), "reuse-topic", { env, store, telegram });
  assert.equal(first.status, 500);
  assert.equal(second.status, 200);
  assert.equal(topicCalls, 2);
  assert.equal(setTopicCalls, 0);
  assert.deepEqual(deletedTopics, [["-100123", 82]]);
});

test("a newly-created topic is deleted when the atomic verification commit loses its race", async () => {
  const user = { user_id: 52, first_name: "Commit race", is_verified: 0, is_blacklisted: 0 };
  const session = { session_id: "commit-race", user_id: 52, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", ...user };
  const deletedTopics = [];
  const released = [];
  let markedArgs;
  const store = {
    async getSession() { return { ...session }; },
    async setLatestFingerprint() {},
    async listBlockedFingerprintLabels() { return []; },
    async getUser() { return { ...user, topic_thread_id: null }; },
    async claimVerificationSession() { return "lease-token"; },
    async releaseVerificationSession(...args) { released.push(args); },
    async markVerified(...args) { markedArgs = args; return null; }
  };
  const telegram = {
    async createForumTopic() { return { message_thread_id: 83 }; },
    async deleteForumTopic(...args) { deletedTopics.push(args); }
  };
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  }), "commit-race", {
    env: { TG_GROUP_ID: "-100123", TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }), IP_METADATA_FETCH: async () => responseJson({}) },
    store,
    telegram
  });
  assert.equal(response.status, 409);
  assert.deepEqual(markedArgs, [52, 83, "commit-race", "lease-token"]);
  assert.deepEqual(deletedTopics, [["-100123", 83]]);
  assert.deepEqual(released, [[52, "commit-race", "lease-token"]]);
});

test("missing topic id fails without marking the user verified", async () => {
  let marked = false;
  let released = false;
  const user = { user_id: 43, first_name: "No topic", is_verified: 0, is_blacklisted: 0 };
  const session = { session_id: "no-topic", user_id: 43, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", ...user };
  const store = {
    async getSession() { return { ...session }; },
    async setLatestFingerprint() {},
    async listBlockedFingerprintLabels() { return []; },
    async getUser() { return { ...user }; },
    async claimVerificationSession() { return true; },
    async releaseVerificationSession() { released = true; },
    async markVerified() { marked = true; return { ...user, is_verified: 1 }; }
  };
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  }), "no-topic", {
    env: { TG_GROUP_ID: "-100123", TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }), IP_METADATA_FETCH: async () => responseJson({}) },
    store,
    telegram: { async createForumTopic() { return {}; }, async sendMessage() { throw new Error("must not send"); } }
  });
  assert.equal(response.status, 500);
  assert.equal(marked, false);
  assert.equal(released, true);
});

test("successful verification deletes its saved prompt best-effort", async () => {
  const deleted = [];
  const user = { user_id: 44, first_name: "Prompt", is_verified: 0, is_blacklisted: 0, verification_prompt_chat_id: 44, verification_prompt_message_id: 9 };
  const session = { session_id: "prompt", user_id: 44, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", ...user };
  const store = {
    async getSession() { return { ...session }; },
    async setLatestFingerprint() {},
    async listBlockedFingerprintLabels() { return []; },
    async getUser() { return { ...user }; },
    async claimVerificationSession() { return true; },
    async markVerified() { return { ...user, is_verified: 1, topic_thread_id: 77 }; }
  };
  const telegram = {
    async createForumTopic() { return { message_thread_id: 77 }; },
    async sendMessage() {},
    async deleteMessage(...args) { deleted.push(args); }
  };
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  }), "prompt", {
    env: { TG_GROUP_ID: "-100123", TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }), IP_METADATA_FETCH: async () => responseJson({}) },
    store,
    telegram
  });
  assert.equal(response.status, 200);
  assert.deepEqual(deleted, [[44, 9]]);
});

test("group notification failure returns a generic error without leaking details", async () => {
  const user = { user_id: 46, first_name: "Telegram error", is_verified: 0, is_blacklisted: 0 };
  const session = { session_id: "telegram-error", user_id: 46, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", ...user };
  let marked = false;
  const store = {
    async getSession() { return { ...session }; },
    async setLatestFingerprint() {},
    async listBlockedFingerprintLabels() { return []; },
    async getUser() { return { ...user }; },
    async claimVerificationSession() { return true; },
    async markVerified() { marked = true; return { ...user, is_verified: 1, topic_thread_id: 78 }; }
  };
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token" })
  }), "telegram-error", {
    env: { TG_GROUP_ID: "-100123", TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }), IP_METADATA_FETCH: async () => responseJson({}) },
    store,
    telegram: {
      async createForumTopic() { return { message_thread_id: 78 }; },
      async sendMessage() { throw new Error("telegram secret detail"); }
    }
  });
  assert.equal(response.status, 500);
  assert.equal(marked, true);
  assert.doesNotMatch(await response.text(), /telegram secret detail/);
});

test("invalid expiry is treated as expired before Turnstile", async () => {
  let called = false;
  const response = await handleVerificationRequest(new Request("https://x/api", { method: "POST" }), "bad-expiry", {
    env: { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => { called = true; } },
    store: { async getSession() { return { session_id: "bad-expiry", user_id: 1, status: "pending", expires_at: "not-a-date" }; } },
    telegram: fakeTelegram()
  });
  assert.equal(response.status, 410);
  assert.equal(called, false);
});

test("malformed fingerprint threshold fails closed to exact matching", async () => {
  const details = {
    os: "未知",
    cpu: { hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0 },
    screen: { width: 1280, height: 800, availWidth: 1280, availHeight: 800, colorDepth: 24, pixelDepth: 24, pixelRatio: 1 },
    fonts: ["Arial"],
    canvas: "same",
    webgl: { hash: "webgl", vendor: "vendor", renderer: "renderer" },
    audio: "audio",
    browser: {}
  };
  const weaker = await buildFingerprintMeta({ system: "未知", fingerprint: { ...details, canvas: "different" } });
  const session = { session_id: "threshold", user_id: 47, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", is_verified: 0, is_blacklisted: 0 };
  let blacklisted = false;
  const store = {
    async getSession() { return { ...session }; },
    async setLatestFingerprint() {},
    async listBlockedFingerprintLabels() { return [{ label_name: "weak", fingerprint_meta: weaker, is_blocked: 1 }]; },
    async blacklistUser() { blacklisted = true; },
    async getUser() { return { ...session }; },
    async claimVerificationSession() { return true; },
    async markVerified() { return { ...session, is_verified: 1, topic_thread_id: 79 }; }
  };
  const response = await handleVerificationRequest(new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token", fingerprint_payload: JSON.stringify(details) })
  }), "threshold", {
    env: { FINGERPRINT_MATCH_THRESHOLD: "not-a-number", TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }), IP_METADATA_FETCH: async () => responseJson({}), TG_GROUP_ID: "-100123" },
    store,
    telegram: { async createForumTopic() { return { message_thread_id: 79 }; }, async sendMessage() {} }
  });
  assert.equal(response.status, 200);
  assert.equal(blacklisted, false);
});

test("empty and out-of-range fingerprint thresholds fail closed", async () => {
  const details = {
    os: "未知",
    cpu: { hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0 },
    screen: { width: 1280, height: 800, availWidth: 1280, availHeight: 800, colorDepth: 24, pixelDepth: 24, pixelRatio: 1 },
    fonts: ["Arial"],
    canvas: "same",
    webgl: { hash: "webgl", vendor: "vendor", renderer: "renderer" },
    audio: "audio",
    browser: {}
  };
  const weaker = await buildFingerprintMeta({ system: "未知", fingerprint: { ...details, canvas: "different" } });
  for (const rawThreshold of ["", "0", "-1", "101"]) {
    let blacklisted = false;
    const session = { session_id: `threshold-${rawThreshold || "empty"}`, user_id: 50, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", is_verified: 0, is_blacklisted: 0 };
    const response = await handleVerificationRequest(new Request("https://x/api", {
      method: "POST",
      body: new URLSearchParams({ "cf-turnstile-response": "token", fingerprint_payload: JSON.stringify(details) })
    }), session.session_id, {
      env: { FINGERPRINT_MATCH_THRESHOLD: rawThreshold, TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }), IP_METADATA_FETCH: async () => responseJson({}) },
      store: {
        async getSession() { return { ...session }; },
        async setLatestFingerprint() {},
        async listBlockedFingerprintLabels() { return [{ label_name: "weak", fingerprint_meta: weaker, is_blocked: 1 }]; },
        async blacklistUser() { blacklisted = true; },
        async getUser() { return { ...session }; },
        async claimVerificationSession() { return true; },
        async markVerified() { return { ...session, is_verified: 1, topic_thread_id: 81 }; }
      },
      telegram: { async createForumTopic() { return { message_thread_id: 81 }; }, async sendMessage() {} }
    });
    assert.equal(response.status, 200);
    assert.equal(blacklisted, false);
  }
});

test("blocked fingerprint blacklists user and returns a 403 result", async () => {
  const telegram = fakeTelegram();
  const user = { user_id: 7, first_name: "Blocked", is_verified: 0, is_blacklisted: 0 };
  const session = { session_id: "blocked", user_id: 7, status: "pending", expires_at: "2099-01-01T00:00:00.000Z", ...user };
  const meta = await buildFingerprintMeta({ system: "未知", fingerprint: { canvas: "blocked" } });
  const calls = [];
  const store = {
    async getSession() { return { ...session }; },
    async setLatestFingerprint(id) { calls.push(["fingerprint", id]); },
    async listBlockedFingerprintLabels() { return [{ id: 1, label_name: "bad", fingerprint_meta: meta, is_blocked: 1 }]; },
    async blacklistUser(id, sid, reason) { calls.push(["blacklist", id, sid, reason]); },
    async getUser() { return user; }
  };
  const request = new Request("https://x/api", {
    method: "POST",
    body: new URLSearchParams({ "cf-turnstile-response": "token", fingerprint_payload: JSON.stringify(meta.details) })
  });
  const response = await handleVerificationRequest(request, "blocked", {
    env: { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_FETCH: async () => responseJson({ success: true }) },
    store,
    telegram
  });
  assert.equal(response.status, 403);
  assert.equal(calls[0][0], "fingerprint");
  assert.equal(calls[1][0], "blacklist");
  assert.equal(telegram.calls.some((call) => call.method === "sendMessage"), true);
});

test("IP metadata prefers request.cf and falls back to a fetch service", async () => {
  const preferred = await lookupIpMetadata("203.0.113.10", {
    cf: { asn: 64500, asOrganization: "Example ISP" }
  }, async () => { throw new Error("should not fetch"); });
  assert.deepEqual(preferred, { ip: "203.0.113.10", asn: "64500", organization: "Example ISP" });

  let requested = "";
  const fallback = await lookupIpMetadata("8.8.8.8", {}, async (url) => {
    requested = url;
    return responseJson({ ip: "8.8.8.8", asn: "AS15169", org: "Google LLC" });
  });
  assert.match(requested, /8\.8\.8\.8/);
  assert.deepEqual(fallback, { ip: "8.8.8.8", asn: "15169", organization: "Google LLC" });
});
