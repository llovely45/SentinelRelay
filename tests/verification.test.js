import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFingerprintMeta,
  handleVerificationRequest,
  lookupIpMetadata,
  verifyTurnstile
} from "../worker/worker.js";
import { fakeStoreWithExpiredSession, fakeTelegram } from "./test-helpers.js";

function responseJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
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
