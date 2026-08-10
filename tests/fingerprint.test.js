import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFingerprintMeta,
  computeFingerprintSimilarity,
  escapeHtml,
  findSimilarFingerprintLabels,
  normalizePublicIpList
} from "../worker/worker.js";

test("fingerprint metadata is stable and exact data scores 100", async () => {
  const input = { system: "macOS", publicIpInfo: { ip: "203.0.113.10" }, webrtcIpInfos: [], fingerprint: { canvas: "c", audio: "a" } };
  const left = await buildFingerprintMeta(input);
  const right = await buildFingerprintMeta(input);
  assert.equal(left.id, right.id);
  assert.equal(computeFingerprintSimilarity(left, right), 100);
});

test("fingerprint hashing sorts nested object keys and normalizes fields", async () => {
  const left = await buildFingerprintMeta({
    system: " macOS ",
    publicIpInfo: { organization: " Org ", ip: "203.0.113.1", asn: 64500 },
    webrtcIpInfos: [{ ip: "192.168.1.1" }, { ip: "8.8.8.8" }],
    fingerprint: { audio: " a ", canvas: " c ", fonts: [" Arial ", ""], cpu: { hardwareConcurrency: 8 } }
  });
  const right = await buildFingerprintMeta({
    fingerprint: { cpu: { hardwareConcurrency: 8 }, fonts: ["Arial"], canvas: "c", audio: "a" },
    webrtcIpInfos: [{ ip: "192.168.1.1" }, { ip: "8.8.8.8" }],
    publicIpInfo: { asn: "64500", ip: "203.0.113.1", organization: "Org" },
    system: "macOS"
  });
  assert.equal(left.id, right.id);
  assert.equal(left.details.os, "macOS");
  assert.deepEqual(left.details.fonts, ["Arial"]);
});

test("similar labels choose the best match once per name and honor threshold", async () => {
  const current = await buildFingerprintMeta({
    system: "Linux",
    publicIpInfo: { ip: "8.8.8.8" },
    fingerprint: { canvas: "same", audio: "same" }
  });
  const exact = await buildFingerprintMeta({
    system: "Linux",
    publicIpInfo: { ip: "8.8.8.8" },
    fingerprint: { canvas: "same", audio: "same" }
  });
  const weaker = await buildFingerprintMeta({
    system: "Windows",
    publicIpInfo: { ip: "8.8.4.4" },
    fingerprint: { canvas: "same" }
  });
  const matches = findSimilarFingerprintLabels(current, [
    { id: 1, label_name: "same", fingerprint_meta: weaker },
    { id: 2, label_name: "same", fingerprint_meta: exact },
    { id: 3, label_name: "below", fingerprint_meta: weaker }
  ], 60);
  assert.deepEqual(matches.map((item) => item.id), [2]);
  assert.equal(matches[0].similarity, 100);
  assert.equal(findSimilarFingerprintLabels(current, [], 60).length, 0);
});

test("public IP normalization filters private and malformed addresses", () => {
  assert.deepEqual(
    normalizePublicIpList("8.8.8.8, 192.168.1.1, 8.8.8.8, ::1, 2001:db8::1, nope"),
    ["8.8.8.8", "2001:db8::1"]
  );
});

test("HTML escaping covers all dangerous characters", () => {
  assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});
