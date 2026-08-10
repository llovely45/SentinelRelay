/*
 * SentinelRelay Cloudflare Worker runtime.
 *
 * This file intentionally has no npm dependencies.  Task 2 owns the durable
 * D1 repository and the pure fingerprint primitives; later tasks add Telegram,
 * verification pages, and routing around these exports.
 */

const textEncoder = new TextEncoder();

// The static deployment page replaces each quoted value below with a
// JSON-escaped literal.  Keeping the configuration in the generated Worker
// means a deployment only needs the D1 binding; environment bindings remain
// an optional override for local tests or operators who prefer secrets there.
const EMBEDDED_CONFIG = {
  TG_BOT_TOKEN: "__TG_BOT_TOKEN__",
  TG_GROUP_ID: "__TG_GROUP_ID__",
  APP_BASE_URL: "__APP_BASE_URL__",
  TURNSTILE_SITE_KEY: "__TURNSTILE_SITE_KEY__",
  TURNSTILE_SECRET_KEY: "__TURNSTILE_SECRET_KEY__",
  TG_WEBHOOK_SECRET: "__TG_WEBHOOK_SECRET__",
  VERIFICATION_TTL_MINUTES: "__VERIFICATION_TTL_MINUTES__",
  STUN_SERVER_URL: "__STUN_SERVER_URL__"
};

// Keep the design-document name available to readers and generated snippets.
const CONFIG = EMBEDDED_CONFIG;

const EMBEDDED_CONFIG_ALIASES = Object.freeze({
  TG_BOT_TOKEN: "TG_BOT_TOKEN",
  tgBotToken: "TG_BOT_TOKEN",
  botToken: "TG_BOT_TOKEN",
  token: "TG_BOT_TOKEN",
  TG_GROUP_ID: "TG_GROUP_ID",
  groupId: "TG_GROUP_ID",
  group_id: "TG_GROUP_ID",
  APP_BASE_URL: "APP_BASE_URL",
  appBaseUrl: "APP_BASE_URL",
  app_base_url: "APP_BASE_URL",
  TURNSTILE_SITE_KEY: "TURNSTILE_SITE_KEY",
  turnstileSiteKey: "TURNSTILE_SITE_KEY",
  siteKey: "TURNSTILE_SITE_KEY",
  TURNSTILE_SECRET_KEY: "TURNSTILE_SECRET_KEY",
  turnstileSecretKey: "TURNSTILE_SECRET_KEY",
  secretKey: "TURNSTILE_SECRET_KEY",
  TG_WEBHOOK_SECRET: "TG_WEBHOOK_SECRET",
  tgWebhookSecret: "TG_WEBHOOK_SECRET",
  webhookSecret: "TG_WEBHOOK_SECRET",
  VERIFICATION_TTL_MINUTES: "VERIFICATION_TTL_MINUTES",
  verificationTtlMinutes: "VERIFICATION_TTL_MINUTES",
  verification_ttl_minutes: "VERIFICATION_TTL_MINUTES",
  STUN_SERVER_URL: "STUN_SERVER_URL",
  stunServerUrl: "STUN_SERVER_URL"
});

/** D1 schema used by every Worker instance.  All statements are idempotent. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  is_verified INTEGER NOT NULL DEFAULT 0,
  is_blacklisted INTEGER NOT NULL DEFAULT 0,
  topic_thread_id INTEGER,
  verification_prompt_chat_id INTEGER,
  verification_prompt_message_id INTEGER,
  latest_fingerprint_id TEXT,
  latest_fingerprint_payload TEXT,
  latest_fingerprint_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_topic_thread_id
  ON users(topic_thread_id)
  WHERE topic_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_state
  ON users(is_verified, is_blacklisted);

CREATE TABLE IF NOT EXISTS verification_sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  fail_reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_verification_user_id
  ON verification_sessions(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS fingerprint_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label_name TEXT NOT NULL,
  note TEXT,
  fingerprint_id TEXT NOT NULL,
  fingerprint_payload TEXT NOT NULL,
  source_user_id INTEGER NOT NULL,
  created_by_user_id INTEGER NOT NULL,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(source_user_id) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_fingerprint_labels_source_user
  ON fingerprint_labels(source_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fingerprint_labels_name
  ON fingerprint_labels(label_name, is_blocked, created_at);

CREATE TABLE IF NOT EXISTS pending_admin_actions (
  thread_id INTEGER NOT NULL,
  admin_id INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, admin_id),
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_admin_actions_expiry
  ON pending_admin_actions(expires_at);

CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_telegram_updates (
  bot_namespace TEXT NOT NULL DEFAULT '',
  update_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (bot_namespace, update_id)
);
CREATE INDEX IF NOT EXISTS idx_processed_telegram_updates_expiry
  ON processed_telegram_updates(status, lease_expires_at);
`;

function normalizeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

/** Return a deterministic clone with object keys sorted recursively. */
function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableObject(value[key]);
      return result;
    }, {});
}

function normalizeIpInfo(info) {
  if (!info || typeof info !== "object") {
    return { ip: "", asn: "", organization: "" };
  }
  return {
    ip: normalizeString(info.ip),
    asn: normalizeString(info.asn),
    organization: normalizeString(info.organization)
  };
}

function normalizeFingerprintDetails(fingerprint = {}, system = "") {
  const source = fingerprint && typeof fingerprint === "object" && fingerprint.details
    && typeof fingerprint.details === "object"
    ? fingerprint.details
    : fingerprint;
  return {
    os: normalizeString(source?.os || system),
    cpu: normalizeObject(source?.cpu),
    screen: normalizeObject(source?.screen),
    fonts: Array.isArray(source?.fonts)
      ? source.fonts.map(normalizeString).filter(Boolean)
      : [],
    canvas: normalizeString(source?.canvas),
    webgl: normalizeObject(source?.webgl),
    audio: normalizeString(source?.audio),
    browser: normalizeObject(source?.browser)
  };
}

async function sha256Hex(value) {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.subtle?.digest) {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }
  const digest = await cryptoObject.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomUuid() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  throw new Error("Web Crypto randomUUID is unavailable");
}

/**
 * Build the canonical fingerprint representation used in D1 and matching.
 * The hash is deliberately computed from the normalized, key-sorted payload.
 */
export async function buildFingerprintMeta({
  system = "",
  publicIpInfo = null,
  webrtcIpInfos = [],
  fingerprint = {}
} = {}) {
  const details = normalizeFingerprintDetails(fingerprint, system);
  const normalizedPublicIpInfo = normalizeIpInfo(publicIpInfo);
  const normalizedWebrtcIpInfos = Array.isArray(webrtcIpInfos)
    ? webrtcIpInfos.map(normalizeIpInfo)
    : [];
  const source = stableObject({
    details,
    publicIpInfo: normalizedPublicIpInfo,
    webrtcIpInfos: normalizedWebrtcIpInfos
  });
  const id = (await sha256Hex(JSON.stringify(source))).slice(0, 24);
  return {
    id,
    publicIpInfo: normalizedPublicIpInfo,
    webrtcIpInfos: normalizedWebrtcIpInfos,
    details
  };
}

export function serializeFingerprintMeta(meta = {}) {
  return JSON.stringify({
    id: normalizeString(meta?.id),
    publicIpInfo: normalizeIpInfo(meta?.publicIpInfo),
    webrtcIpInfos: Array.isArray(meta?.webrtcIpInfos)
      ? meta.webrtcIpInfos.map(normalizeIpInfo)
      : [],
    details: normalizeFingerprintDetails(meta?.details)
  });
}

export function parseStoredFingerprintMeta(rawValue) {
  if (!rawValue) return null;
  try {
    const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      id: normalizeString(parsed.id),
      publicIpInfo: normalizeIpInfo(parsed.publicIpInfo),
      webrtcIpInfos: Array.isArray(parsed.webrtcIpInfos)
        ? parsed.webrtcIpInfos.map(normalizeIpInfo)
        : [],
      details: normalizeFingerprintDetails(parsed.details)
    };
  } catch {
    return null;
  }
}

function compareStrings(left, right) {
  if (!left || !right) return 0;
  return normalizeString(left) === normalizeString(right) ? 1 : 0;
}

function compareNumberLike(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return 0;
  return Number(left) === Number(right) ? 1 : 0;
}

function compareObjectKeys(left, right, keys) {
  const values = keys.map((key) => compareNumberLike(left?.[key], right?.[key]));
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compareFonts(left = [], right = []) {
  const a = new Set(left.map(normalizeString).filter(Boolean));
  const b = new Set(right.map(normalizeString).filter(Boolean));
  if (a.size === 0 || b.size === 0 || a.size !== b.size) return 0;
  for (const value of a) if (!b.has(value)) return 0;
  return 1;
}

function compareWebGl(left = {}, right = {}) {
  const values = [
    compareStrings(left?.hash, right?.hash),
    compareStrings(left?.vendor, right?.vendor),
    compareStrings(left?.renderer, right?.renderer)
  ];
  return values.every((value) => value === 1) ? 1 : 0;
}

function compareCpu(left = {}, right = {}) {
  return compareObjectKeys(left, right, ["hardwareConcurrency", "deviceMemory", "maxTouchPoints"]) === 1 ? 1 : 0;
}

function compareScreen(left = {}, right = {}) {
  return compareObjectKeys(left, right, [
    "width", "height", "availWidth", "availHeight", "colorDepth", "pixelDepth", "pixelRatio"
  ]) === 1 ? 1 : 0;
}

function weightedAverage(parts) {
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight === 0) return 0;
  return Math.round(parts.reduce((sum, part) => sum + part.weight * part.value, 0) / totalWeight * 100);
}

function isIpv4(ip) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
  return ip.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function isIpv6(ip) {
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(":")) return false;
  const halves = ip.split("::");
  if (halves.length > 2) return false;
  const validPart = (part) => part.length > 0 && /^[0-9a-f]{1,4}$/i.test(part);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => !validPart(part)) || right.some((part) => !validPart(part))) return false;
  return halves.length === 2 ? left.length + right.length < 8 : left.length === 8;
}

function isPrivateIpv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase();
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd")
    || lower.startsWith("fe80:");
}

function isPublicIp(ip) {
  return isIpv4(ip) ? !isPrivateIpv4(ip) : isIpv6(ip) && !isPrivateIpv6(ip);
}

/** Keep only unique public IPv4/IPv6 addresses from a comma-delimited value. */
export function normalizePublicIpList(value) {
  const values = Array.isArray(value) ? value : [value];
  return Array.from(new Set(values
    .flatMap((item) => String(item ?? "").split(","))
    .map((item) => item.trim())
    .filter(isPublicIp)));
}

function ipSimilarity(left, right) {
  return left && right && normalizeString(left) === normalizeString(right) ? 1 : 0;
}

function buildSimilarityDetails(currentMeta, labeledMeta) {
  const currentWebrtc = currentMeta?.webrtcIpInfos?.[0] || {};
  const labeledWebrtc = labeledMeta?.webrtcIpInfos?.[0] || {};
  const fields = [
    ["webrtc_ip", "webrtc ip", ipSimilarity(currentWebrtc.ip, labeledWebrtc.ip), currentWebrtc.ip],
    ["webrtc_asn", "webrtc asn", compareStrings(currentWebrtc.asn, labeledWebrtc.asn), currentWebrtc.asn],
    ["webrtc_isp", "webrtc isp", compareStrings(currentWebrtc.organization, labeledWebrtc.organization), currentWebrtc.organization],
    ["public_ip", "公网 ip", ipSimilarity(currentMeta?.publicIpInfo?.ip, labeledMeta?.publicIpInfo?.ip), currentMeta?.publicIpInfo?.ip],
    ["public_asn", "公网 asn", compareStrings(currentMeta?.publicIpInfo?.asn, labeledMeta?.publicIpInfo?.asn), currentMeta?.publicIpInfo?.asn],
    ["public_isp", "公网 isp", compareStrings(currentMeta?.publicIpInfo?.organization, labeledMeta?.publicIpInfo?.organization), currentMeta?.publicIpInfo?.organization],
    ["canvas", "canvas指纹", compareStrings(currentMeta?.details?.canvas, labeledMeta?.details?.canvas), currentMeta?.details?.canvas],
    ["webgl", "webgl指纹", compareWebGl(currentMeta?.details?.webgl, labeledMeta?.details?.webgl), currentMeta?.details?.webgl?.hash],
    ["audio", "audio指纹", compareStrings(currentMeta?.details?.audio, labeledMeta?.details?.audio), currentMeta?.details?.audio],
    ["os", "系统", compareStrings(currentMeta?.details?.os, labeledMeta?.details?.os), currentMeta?.details?.os],
    ["cpu", "cpu", compareCpu(currentMeta?.details?.cpu, labeledMeta?.details?.cpu), JSON.stringify(currentMeta?.details?.cpu || {})],
    ["screen", "screen", compareScreen(currentMeta?.details?.screen, labeledMeta?.details?.screen), JSON.stringify(currentMeta?.details?.screen || {})],
    ["fonts", "fonts", compareFonts(currentMeta?.details?.fonts, labeledMeta?.details?.fonts), (currentMeta?.details?.fonts || []).join(", ")]
  ];
  return fields.filter(([, , score]) => score > 0).map(([key, label, score, value]) => ({
    key,
    label,
    score,
    status: score >= 1 ? "相同" : "",
    value: value || ""
  }));
}

/** Existing 40% network / 60% device blended similarity calculation. */
export function computeFingerprintSimilarity(currentMeta, labeledMeta) {
  if (!currentMeta || !labeledMeta) return 0;
  // The canonical hash is a strong equality signal.  It also makes an exact
  // match score 100 when optional browser signals were unavailable on both
  // sides (the weighted fields below intentionally treat missing values as
  // unknown rather than equal).
  if (currentMeta.id && labeledMeta.id && String(currentMeta.id) === String(labeledMeta.id)) return 100;
  const currentWebrtc = currentMeta.webrtcIpInfos?.[0] || {};
  const labeledWebrtc = labeledMeta.webrtcIpInfos?.[0] || {};
  const networkScore = weightedAverage([
    { weight: 40, value: ipSimilarity(currentMeta.publicIpInfo?.ip, labeledMeta.publicIpInfo?.ip) },
    { weight: 10, value: compareStrings(currentMeta.publicIpInfo?.asn, labeledMeta.publicIpInfo?.asn) },
    { weight: 10, value: compareStrings(currentMeta.publicIpInfo?.organization, labeledMeta.publicIpInfo?.organization) },
    { weight: 20, value: ipSimilarity(currentWebrtc.ip, labeledWebrtc.ip) },
    { weight: 10, value: compareStrings(currentWebrtc.asn, labeledWebrtc.asn) },
    { weight: 10, value: compareStrings(currentWebrtc.organization, labeledWebrtc.organization) }
  ]);
  const deviceScore = weightedAverage([
    { weight: 25, value: compareStrings(currentMeta.details?.canvas, labeledMeta.details?.canvas) },
    { weight: 20, value: compareWebGl(currentMeta.details?.webgl, labeledMeta.details?.webgl) },
    { weight: 15, value: compareStrings(currentMeta.details?.audio, labeledMeta.details?.audio) },
    { weight: 10, value: compareStrings(currentMeta.details?.os, labeledMeta.details?.os) },
    { weight: 10, value: compareCpu(currentMeta.details?.cpu, labeledMeta.details?.cpu) },
    { weight: 10, value: compareScreen(currentMeta.details?.screen, labeledMeta.details?.screen) },
    { weight: 10, value: compareFonts(currentMeta.details?.fonts, labeledMeta.details?.fonts) }
  ]);
  const blended = Math.round(networkScore * 0.4 + deviceScore * 0.6);
  return Math.max(networkScore, deviceScore, blended);
}

function labelMeta(label) {
  if (!label) return null;
  if (label.fingerprint_meta) return label.fingerprint_meta;
  if (label.fingerprintMeta) return label.fingerprintMeta;
  return parseStoredFingerprintMeta(label.fingerprint_payload);
}

/** Return at most the best threshold match for each label name. */
export function findSimilarFingerprintLabels(currentMeta, labels = [], threshold = 60) {
  const bestByName = new Map();
  const safeThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 60;
  for (const label of Array.isArray(labels) ? labels : []) {
    const meta = labelMeta(label);
    const similarity = computeFingerprintSimilarity(currentMeta, meta);
    if (similarity < safeThreshold) continue;
    const name = normalizeString(label.label_name ?? label.labelName) || String(label.id ?? "");
    const candidate = {
      ...label,
      fingerprint_meta: meta,
      similarity,
      matched_fields: buildSimilarityDetails(currentMeta, meta)
    };
    const previous = bestByName.get(name);
    if (!previous || candidate.similarity > previous.similarity) bestByName.set(name, candidate);
  }
  return [...bestByName.values()].sort((left, right) => right.similarity - left.similarity);
}

/** Escape values interpolated into Telegram HTML or verification pages. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Verify a browser Turnstile response at Cloudflare's server-side endpoint.
 * Secrets and tokens are deliberately not included in errors returned to a
 * caller, because Worker errors are often rendered directly to a browser.
 */
export async function verifyTurnstile({
  secretKey,
  token,
  remoteIp,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!normalizeString(secretKey)) throw new TypeError("Turnstile secret key is required");
  if (!normalizeString(token)) throw new TypeError("Turnstile token is required");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");

  const body = new URLSearchParams();
  body.set("secret", String(secretKey));
  body.set("response", String(token));
  if (normalizeString(remoteIp)) body.set("remoteip", normalizeString(remoteIp));

  let response;
  try {
    response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
  } catch {
    throw new Error("Turnstile verification request failed");
  }

  const status = Number(response?.status);
  const ok = response && (response.ok !== false) && (!Number.isFinite(status) || (status >= 200 && status < 300));
  if (!ok) throw new Error("Turnstile verification request failed");
  try {
    const result = await response.json();
    return result && typeof result === "object" ? result : { success: false };
  } catch {
    throw new Error("Turnstile verification returned an invalid response");
  }
}

// Keep the source-project name available for integrations that still call it.
export const verifyTurnstileToken = verifyTurnstile;

function normalizeAsn(value) {
  return normalizeString(value).replace(/^AS/i, "");
}

function normalizeMetadataResult(ip, value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const source = raw.data && typeof raw.data === "object"
    ? raw.data
    : raw.result && typeof raw.result === "object" ? raw.result : raw;
  const nestedConnection = source.connection && typeof source.connection === "object"
    ? source.connection : {};
  const nestedCompany = source.company && typeof source.company === "object"
    ? source.company : {};
  return {
    // Keep the caller's normalized address as the key even if a provider
    // returns a missing or surprising `ip` field.
    ip: normalizeString(ip),
    asn: normalizeAsn(source.asn || source.as || source.asnNumber || source.autonomous_system_number || nestedConnection.asn),
    organization: normalizeString(
      source.organization || source.org || source.asOrganization || source.isp
      || source.autonomous_system_organization || nestedConnection.organization
      || nestedConnection.org || nestedCompany.name
    )
  };
}

/**
 * Read ASN/organization metadata from Cloudflare request.cf where available;
 * otherwise use a small public HTTP lookup.  Metadata is advisory: a failed
 * lookup returns null and the caller can retain the normalized IP itself.
 */
export async function lookupIpMetadata(
  ip,
  request = null,
  fetchImpl = globalThis.fetch,
  { timeoutMs = 3000, setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}
) {
  const normalizedIp = normalizeString(ip);
  if (!normalizedIp || !isPublicIp(normalizedIp)) return null;

  const cf = request?.cf && typeof request.cf === "object" ? request.cf : {};
  const fromCf = normalizeMetadataResult(normalizedIp, {
    ip: normalizedIp,
    asn: cf.asn,
    asOrganization: cf.asOrganization || cf.as_organization || cf.organization
  });
  if (fromCf.asn || fromCf.organization) return fromCf;
  if (typeof fetchImpl !== "function") return null;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutDuration = Math.max(1, Number(timeoutMs) || 3000);
  let timeout = null;
  let timeoutPromise = null;
  if (typeof setTimeoutImpl === "function") {
    timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeoutImpl(() => {
        try { controller?.abort(); } catch {}
        reject(new Error("IP metadata lookup timed out"));
      }, timeoutDuration);
    });
  }

  try {
    // ipapi.co is intentionally used only as a fallback.  The request never
    // carries the Turnstile token, Telegram credentials, or browser payload.
    const fetchPromise = fetchImpl(`https://ipapi.co/${encodeURIComponent(normalizedIp)}/json/`, {
      headers: { Accept: "application/json" },
      ...(controller ? { signal: controller.signal } : {})
    });
    const response = timeoutPromise ? await Promise.race([fetchPromise, timeoutPromise]) : await fetchPromise;
    const status = Number(response?.status);
    const ok = response && response.ok !== false
      && (!Number.isFinite(status) || (status >= 200 && status < 300));
    if (!ok) return null;
    const jsonPromise = response.json();
    const payload = timeoutPromise ? await Promise.race([jsonPromise, timeoutPromise]) : await jsonPromise;
    const result = normalizeMetadataResult(normalizedIp, payload);
    return result.ip ? result : null;
  } catch {
    return null;
  } finally {
    if (timeout !== null && typeof clearTimeoutImpl === "function") clearTimeoutImpl(timeout);
  }
}

function requestHeader(request, name) {
  try {
    return normalizeString(request?.headers?.get?.(name));
  } catch {
    return "";
  }
}

function requestClientIp(request) {
  const direct = requestHeader(request, "cf-connecting-ip");
  if (direct) return direct.split(",")[0].trim();
  const forwarded = requestHeader(request, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return normalizeString(request?.cf?.clientIp || request?.ip);
}

function detectClientSystem(request) {
  const userAgent = `${requestHeader(request, "user-agent")} ${normalizeString(request?.cf?.clientAcceptEncoding)}`.toLowerCase();
  if (userAgent.includes("android")) return "Android";
  if (userAgent.includes("iphone") || userAgent.includes("ipad") || userAgent.includes("ipod")) return "iOS";
  if (userAgent.includes("windows nt") || userAgent.includes("windows")) return "Windows";
  if (userAgent.includes("mac os x") || userAgent.includes("macintosh") || userAgent.includes("mac")) return "macOS";
  if (userAgent.includes("linux")) return "Linux";
  return "未知";
}

const MAX_WEBRTC_INPUT_BYTES = 4096;
const MAX_WEBRTC_IP_COUNT = 8;
const MAX_FINGERPRINT_PAYLOAD_BYTES = 64 * 1024;
const MAX_FINGERPRINT_FIELD_BYTES = 4096;
const MAX_FINGERPRINT_DEPTH = 8;
const MAX_FINGERPRINT_KEYS_PER_OBJECT = 128;
const MAX_TURNSTILE_TOKEN_BYTES = 4096;
const MAX_VERIFICATION_REQUEST_BYTES = 128 * 1024;
const PROCESSED_UPDATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

class VerificationInputError extends Error {
  constructor(message, status = 413) {
    super(message);
    this.name = "VerificationInputError";
    this.status = status;
  }
}

function utf8ByteLength(value) {
  return textEncoder.encode(String(value ?? "")).byteLength;
}

function assertFingerprintValueWithinBounds(value, depth = 0) {
  if (depth > MAX_FINGERPRINT_DEPTH) {
    throw new VerificationInputError("fingerprint_depth");
  }
  if (typeof value === "string") {
    if (utf8ByteLength(value) > MAX_FINGERPRINT_FIELD_BYTES) {
      throw new VerificationInputError("fingerprint_field");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new VerificationInputError("fingerprint_number", 400);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > MAX_FINGERPRINT_KEYS_PER_OBJECT) {
      throw new VerificationInputError("fingerprint_array");
    }
    for (const item of value) assertFingerprintValueWithinBounds(item, depth + 1);
    return;
  }
  if (typeof value !== "object") throw new VerificationInputError("fingerprint_type", 400);
  const keys = Object.keys(value);
  if (keys.length > MAX_FINGERPRINT_KEYS_PER_OBJECT) {
    throw new VerificationInputError("fingerprint_object");
  }
  for (const key of keys) {
    if (utf8ByteLength(key) > MAX_FINGERPRINT_FIELD_BYTES) {
      throw new VerificationInputError("fingerprint_key");
    }
    assertFingerprintValueWithinBounds(value[key], depth + 1);
  }
}

async function readVerificationForm(request) {
  const contentType = requestHeader(request, "content-type").toLowerCase();
  try {
    if (contentType.includes("application/json")) {
      const body = await request.json();
      return body && typeof body === "object" ? body : {};
    }
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    try {
      const raw = await request.text();
      return Object.fromEntries(new URLSearchParams(raw).entries());
    } catch {
      return {};
    }
  }
}

function parseFingerprintPayload(value) {
  if (!value) return {};
  let raw = value;
  if (typeof value === "object") {
    try { raw = JSON.stringify(value); } catch { throw new VerificationInputError("fingerprint_json", 400); }
  }
  if (utf8ByteLength(raw) > MAX_FINGERPRINT_PAYLOAD_BYTES) {
    throw new VerificationInputError("fingerprint_payload");
  }
  if (typeof value === "object") {
    if (Array.isArray(value)) throw new VerificationInputError("fingerprint_type", 400);
    assertFingerprintValueWithinBounds(value);
    return value;
  }
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new VerificationInputError("fingerprint_type", 400);
    }
    assertFingerprintValueWithinBounds(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof VerificationInputError) throw error;
    throw new VerificationInputError("fingerprint_json", 400);
  }
}

function validateVerificationInput(form = {}) {
  const rawWebrtc = form.webrtc_ip ?? form.webrtc_ips ?? form.webrtcIp ?? "";
  if (utf8ByteLength(rawWebrtc) > MAX_WEBRTC_INPUT_BYTES) {
    throw new VerificationInputError("webrtc_payload");
  }
  const webrtcIps = normalizePublicIpList(rawWebrtc);
  if (webrtcIps.length > MAX_WEBRTC_IP_COUNT) {
    throw new VerificationInputError("webrtc_ip_count");
  }
  const fingerprint = parseFingerprintPayload(form.fingerprint_payload || form.fingerprint || "");
  return { webrtcIps, fingerprint };
}

function pageErrorResponse(options = {}, status = 400) {
  const page = options.miniApp
    ? renderMiniAppVerificationPage(options)
    : renderVerificationPage(options);
  return new Response(page, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function resultResponse(title, description, status = 200) {
  return new Response(renderResultPage({ title, description }), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function telegramUserName(user = {}) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || user.username || `User ${user.user_id ?? user.id ?? ""}`;
}

function telegramUserInfo(user = {}) {
  return [
    "新用户验证通过",
    `用户ID: ${user.user_id ?? user.id ?? ""}`,
    `昵称: ${telegramUserName(user)}`,
    `用户名: ${user.username ? `@${user.username}` : "无"}`,
    `语言: ${user.language_code || "未知"}`
  ].join("\n");
}

async function notifyTelegram(telegram, userId, text, options = {}) {
  if (!telegram) return;
  if (typeof telegram.sendMessage === "function") {
    try { await telegram.sendMessage(userId, text, options); } catch {}
  } else if (typeof telegram.notifyBlacklist === "function") {
    try { await telegram.notifyBlacklist(userId, text); } catch {}
  }
}

async function notifyTelegramGroup(telegram, groupId, text, options = {}) {
  if (!telegram || groupId === "" || groupId === null || groupId === undefined) return;
  if (typeof telegram.sendMessage === "function") {
    try { await telegram.sendMessage(groupId, text, options); } catch {}
  }
}

/**
 * Handle both the regular verification form and the Telegram Mini App form.
 * Session state is checked before reading the form or making any external
 * request, which keeps expired links one-shot and avoids unnecessary calls.
 */
export async function handleVerificationRequest(
  request,
  sessionId,
  { miniApp = false, env = {}, store, telegram } = {}
) {
  if (!store || typeof store.getSession !== "function") throw new TypeError("store is required");
  const requestMethod = String(request?.method || "GET").toUpperCase();
  const declaredLength = Number(requestHeader(request, "content-length"));
  if (requestMethod === "POST"
    && Number.isFinite(declaredLength)
    && declaredLength > MAX_VERIFICATION_REQUEST_BYTES) {
    return pageErrorResponse({
      miniApp,
      siteKey: configValue(env, ["TURNSTILE_SITE_KEY", "turnstileSiteKey", "siteKey"], ""),
      sessionId: normalizeString(sessionId),
      errorMessage: "验证数据过大，请缩减后重试。",
      stunServerUrl: configValue(env, ["STUN_SERVER_URL", "stunServerUrl"], "stun:stun.miwifi.com:3478")
    }, 413);
  }
  let id = normalizeString(sessionId);
  let preReadForm = null;
  if (!id && miniApp) {
    try {
      const url = new URL(request?.url || "https://sentinelrelay.invalid/miniapp");
      id = normalizeString(url.searchParams.get("session") || url.searchParams.get("startapp") || url.searchParams.get("tgWebAppStartParam"));
    } catch {}
    if (!id) {
      preReadForm = await readVerificationForm(request);
      id = normalizeString(preReadForm.session_id || preReadForm.session || preReadForm.startapp);
    }
  }
  let session = await store.getSession(id);
  const siteKey = configValue(env, ["TURNSTILE_SITE_KEY", "turnstileSiteKey", "siteKey"], "");
  const basePageOptions = {
    siteKey,
    sessionId: id,
    errorMessage: "",
    stunServerUrl: configValue(env, ["STUN_SERVER_URL", "stunServerUrl"], "stun:stun.miwifi.com:3478")
  };

  if (!session) return resultResponse("链接无效", "该验证链接不存在。", 404);
  if (Number(session.is_blacklisted)) {
    return resultResponse("已拒绝访问", "该用户已被加入黑名单。", 403);
  }
  if (session.status === "passed" || Number(session.is_verified)) {
    return resultResponse("已验证", "你已经通过验证，现在可以回到 Telegram 继续聊天。", 200);
  }
  if (session.status === "processing") {
    if (!isExpiredTimestamp(session.consumed_at)) {
      return resultResponse("验证处理中", "验证请求正在处理，请稍后重试。", 409);
    }
    // A crashed Worker can leave a processing lease behind.  Treat a stale
    // lease as pending and let the D1 claim transition take it over.
    session = { ...session, status: "pending" };
  }
  if (session.status !== "pending" || isExpiredTimestamp(session.expires_at)) {
    return resultResponse("链接已过期", "请重新在 Telegram 中获取新的验证链接。", 410);
  }
  if (request?.method && String(request.method).toUpperCase() === "GET") {
    return new Response(
      miniApp ? renderMiniAppVerificationPage(basePageOptions) : renderVerificationPage(basePageOptions),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  if (request?.method && String(request.method).toUpperCase() !== "POST") {
    return pageErrorResponse({ ...basePageOptions, miniApp, errorMessage: "请提交验证表单。" }, 405);
  }

  const form = preReadForm || await readVerificationForm(request);
  let boundedInput;
  try {
    boundedInput = validateVerificationInput(form);
  } catch (error) {
    const status = error instanceof VerificationInputError ? error.status : 400;
    const message = status === 413
      ? "验证数据过大，请缩减后重试。"
      : "验证数据格式无效，请重试。";
    return pageErrorResponse({ ...basePageOptions, miniApp, errorMessage: message }, status);
  }
  const token = normalizeString(form["cf-turnstile-response"] || form.turnstile_token || form.token);
  if (!token) {
    return pageErrorResponse({ ...basePageOptions, miniApp, errorMessage: "缺少 Turnstile 验证结果，请重试。" }, 400);
  }
  if (utf8ByteLength(token) > MAX_TURNSTILE_TOKEN_BYTES) {
    return pageErrorResponse({ ...basePageOptions, miniApp, errorMessage: "验证数据过大，请缩减后重试。" }, 413);
  }

  const remoteIp = requestClientIp(request);
  const turnstileFetch = env.TURNSTILE_FETCH || env.fetchImpl || globalThis.fetch;
  let turnstile;
  try {
    turnstile = await verifyTurnstile({
      secretKey: configValue(env, ["TURNSTILE_SECRET_KEY", "turnstileSecretKey"], ""),
      token,
      remoteIp,
      fetchImpl: turnstileFetch
    });
  } catch {
    return pageErrorResponse({ ...basePageOptions, miniApp, errorMessage: "验证服务暂时不可用，请稍后重试。" }, 500);
  }

  if (!turnstile?.success) {
    const reason = Array.isArray(turnstile?.["error-codes"])
      ? turnstile["error-codes"].slice(0, 8).join(", ")
      : "turnstile_failed";
    if (typeof store.blacklistUser === "function") {
      try { await store.blacklistUser(session.user_id, id, reason); } catch {}
    }
    await notifyTelegramGroup(
      telegram,
      configValue(env, ["TG_GROUP_ID", "groupId", "group_id"], ""),
      ["用户验证失败，已加入黑名单", `用户ID: ${session.user_id}`, `原因: ${reason}`].join("\n")
    );
    await notifyTelegram(telegram, session.user_id, "验证失败，当前用户已加入黑名单。", {});
    return resultResponse("验证失败", "验证未通过，当前用户已加入黑名单。", 403);
  }

  const groupId = configValue(env, ["TG_GROUP_ID", "groupId", "group_id"], "");
  let claimToken = null;
  let marked = false;
  let createdThreadId = null;
  const deleteCreatedTopic = async () => {
    const numericThreadId = Number(createdThreadId);
    if (createdThreadId === null || createdThreadId === undefined
      || !Number.isInteger(numericThreadId) || numericThreadId <= 0
      || typeof telegram?.deleteForumTopic !== "function") return;
    try { await telegram.deleteForumTopic(groupId, numericThreadId); } catch {}
  };
  try {
    const { webrtcIps, fingerprint } = boundedInput;
    const allIps = Array.from(new Set([remoteIp, ...webrtcIps].filter(Boolean)));
    const metadataFetch = env.IP_METADATA_FETCH || env.fetchImpl || globalThis.fetch;
    const metadataTimeoutMs = configValue(env, ["IP_METADATA_TIMEOUT_MS", "ipMetadataTimeoutMs"], 3000);
    const metadataList = await Promise.all(allIps.map((ip) => lookupIpMetadata(
      ip,
      ip === remoteIp ? request : null,
      metadataFetch,
      { timeoutMs: metadataTimeoutMs }
    )));
    const metadataByIp = new Map(metadataList.filter(Boolean).map((item) => [item.ip, item]));
    const publicIpInfo = remoteIp
      ? (metadataByIp.get(remoteIp) || { ip: remoteIp, asn: "", organization: "" })
      : null;
    const fingerprintMeta = await buildFingerprintMeta({
      system: detectClientSystem(request),
      publicIpInfo,
      webrtcIpInfos: webrtcIps.map((ip) => metadataByIp.get(ip) || { ip, asn: "", organization: "" }),
      fingerprint
    });

    // Persist before reading labels: this makes the latest fingerprint visible
    // to administrators even if the subsequent match rejects the user.
    if (typeof store.setLatestFingerprint === "function") {
      await store.setLatestFingerprint(session.user_id, fingerprintMeta);
    }
    let labels = [];
    if (typeof store.listBlockedFingerprintLabels === "function") {
      labels = await store.listBlockedFingerprintLabels();
    } else if (typeof store.listFingerprintLabels === "function") {
      labels = (await store.listFingerprintLabels()).filter((label) => Number(label.is_blocked));
    }
    // A blocked label is intentionally an exact match by default. Operators
    // can opt into a bounded lower threshold explicitly.
    const rawThreshold = normalizeString(configValue(env, ["FINGERPRINT_MATCH_THRESHOLD", "fingerprintMatchThreshold"], 100));
    const configuredThreshold = Number(rawThreshold);
    const thresholdValue = rawThreshold !== "" && Number.isFinite(configuredThreshold)
      && configuredThreshold > 0 && configuredThreshold <= 100
      ? configuredThreshold
      : 100;
    const blockedMatches = findSimilarFingerprintLabels(fingerprintMeta, labels, thresholdValue)
      .filter((label) => label.is_blocked === undefined || Number(label.is_blocked));
    if (blockedMatches.length) {
      const reason = `fingerprint_blocked:${blockedMatches.map((label) => normalizeString(label.label_name)).filter(Boolean).join(",")}`;
      if (typeof store.blacklistUser === "function") {
        await store.blacklistUser(session.user_id, id, reason);
      }
      const groupId = configValue(env, ["TG_GROUP_ID", "groupId", "group_id"], "");
      await notifyTelegramGroup(
        telegram,
        groupId,
        [
          "用户验证失败，命中屏蔽标签",
          `用户ID: ${session.user_id}`,
          `昵称: ${telegramUserName(session)}`,
          `标签: ${blockedMatches.map((label) => normalizeString(label.label_name)).filter(Boolean).join(", ")}`,
          `指纹: ${fingerprintMeta.id}`,
          "处理: 已加入黑名单，未创建话题，消息不会转发。"
        ].join("\n")
      );
      await notifyTelegram(telegram, session.user_id, "验证未通过，你的设备指纹命中屏蔽标签。", {});
      return resultResponse("验证未通过", "你的设备指纹命中屏蔽标签，消息不会被转发。", 403);
    }

    const currentUser = typeof store.getUser === "function"
      ? (await store.getUser(session.user_id) || session)
      : session;
    if (typeof store.claimVerificationSession === "function") {
      claimToken = await store.claimVerificationSession(session.user_id, id);
      if (!claimToken) {
        return resultResponse("验证已处理", "该验证会话已被其他请求处理，请回到 Telegram 继续聊天。", 409);
      }
    }
    let threadId = currentUser.topic_thread_id || session.topic_thread_id || null;
    if (threadId === null || threadId === undefined || threadId === "") {
      if (typeof telegram?.createForumTopic !== "function") throw new Error("Telegram topic creation is unavailable");
      const topicName = currentUser.username
        ? `${currentUser.first_name || "User"} (@${currentUser.username})`
        : `${currentUser.first_name || "User"} (${currentUser.user_id})`;
      const topic = await telegram.createForumTopic(groupId, topicName.slice(0, 120));
      threadId = topic?.message_thread_id ?? topic?.messageThreadId;
      createdThreadId = threadId;
    }
    const numericThreadId = Number(threadId);
    if (!Number.isInteger(numericThreadId) || numericThreadId <= 0) {
      throw new Error("Telegram did not return a valid forum topic id");
    }

    const verifiedUser = typeof store.markVerified === "function"
      ? await store.markVerified(session.user_id, numericThreadId, id, claimToken)
      : currentUser;
    if (!verifiedUser && typeof store.markVerified === "function") {
      await deleteCreatedTopic();
      if (claimToken && typeof store.releaseVerificationSession === "function") {
        try { await store.releaseVerificationSession(session.user_id, id, claimToken); } catch {}
      }
      return resultResponse("验证已处理", "该验证会话已被其他请求处理，请回到 Telegram 继续聊天。", 409);
    }
    marked = typeof store.markVerified === "function";

    const promptChatId = currentUser.verification_prompt_chat_id ?? session.verification_prompt_chat_id;
    const promptMessageId = currentUser.verification_prompt_message_id ?? session.verification_prompt_message_id;
    if (typeof telegram?.deleteMessage === "function"
      && promptChatId !== null && promptChatId !== undefined
      && promptMessageId !== null && promptMessageId !== undefined) {
      try { await telegram.deleteMessage(promptChatId, promptMessageId); } catch {}
    }

    const userForNotice = {
      ...(currentUser || session || {}),
      ...(verifiedUser || {})
    };
    await notifyTelegramGroup(
      telegram,
      groupId,
      [
        telegramUserInfo(userForNotice),
        `指纹: ${fingerprintMeta.id}`,
        `公网 IP: ${fingerprintMeta.publicIpInfo?.ip || "无"}`
      ].join("\n"),
      { message_thread_id: numericThreadId }
    );
    await notifyTelegram(telegram, session.user_id, "验证成功，请回到 Telegram 继续聊天。", {});
    return resultResponse("验证成功", "验证已通过，请回到 Telegram 继续聊天。", 200);
  } catch {
    if (!marked) await deleteCreatedTopic();
    if (claimToken && !marked && typeof store.releaseVerificationSession === "function") {
      try { await store.releaseVerificationSession(session.user_id, id, claimToken); } catch {}
    }
    return resultResponse("验证服务异常", "验证服务暂时不可用，请稍后重试。", 500);
  }
}

function renderVerificationPageHtml({
  siteKey,
  formAction,
  errorMessage = "",
  includeTelegramWebApp = false,
  initialSessionId = "",
  miniAppMode = false,
  stunServerUrl = "stun:stun.miwifi.com:3478"
} = {}) {
  const safeError = escapeHtml(errorMessage);
  const safeSiteKey = escapeHtml(siteKey);
  const safeAction = escapeHtml(formAction);
  const safeSession = escapeHtml(initialSessionId);
  const safeStun = JSON.stringify(String(stunServerUrl || "stun:stun.miwifi.com:3478"))
    .replace(/[<>&\u2028\u2029]/g, (character) => ({
      "<": "\\u003C",
      ">": "\\u003E",
      "&": "\\u0026",
      "\u2028": "\\u2028",
      "\u2029": "\\u2029"
    }[character]));
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>身份验证</title>
    ${includeTelegramWebApp ? '<script src="https://telegram.org/js/telegram-web-app.js"></script>' : ""}
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <style>
      :root { color-scheme: light; --bg:#f4efe7; --panel:#fff9f0; --ink:#1e1a16; --accent:#d26a2f; --line:#e6d4bf; }
      * { box-sizing: border-box; }
      body { margin:0; min-height:100vh; padding:20px; display:grid; place-items:center; color:var(--ink); background:radial-gradient(circle at top left,#ffe5c8 0,transparent 32%),radial-gradient(circle at bottom right,#ffd7b5 0,transparent 28%),var(--bg); font-family:"Segoe UI","PingFang SC",sans-serif; }
      .card { width:min(100%,460px); padding:28px; border:1px solid var(--line); border-radius:24px; background:rgba(255,249,240,.94); box-shadow:0 22px 70px rgba(76,44,19,.12); }
      h1 { margin:0 0 10px; font-size:28px; } p { margin:0 0 16px; line-height:1.6; }
      .privacy-notice { margin:0 0 18px; padding:13px 14px; border:1px solid #e8c59f; border-radius:14px; background:#fff2dd; color:#6d421d; font-size:13px; line-height:1.6; }
      .privacy-notice strong { display:block; margin-bottom:4px; color:#4f2c13; }
      .error { margin-bottom:16px; padding:12px 14px; border:1px solid #f2c1af; border-radius:14px; background:#fff0eb; color:#a13d17; }
      .status { margin-top:12px; color:#7b4b25; font-size:13px; line-height:1.5; }
      button { width:100%; margin-top:18px; padding:14px 18px; border:0; border-radius:999px; background:linear-gradient(135deg,var(--accent),#9f4719); color:#fff; font-size:16px; cursor:pointer; }
      button:disabled { opacity:.5; cursor:not-allowed; } .footer { margin-top:14px; opacity:.8; font-size:13px; } .hidden { display:none; }
    </style>
    <script>
      window.onTurnstileSuccess = function () {
        const button = document.getElementById("verify_button");
        const status = document.getElementById("turnstile_status");
        if (button) { button.disabled = false; button.textContent = "完成验证"; }
        if (status) status.textContent = "Cloudflare 验证已完成，可以点击按钮。";
      };
      window.onTurnstileExpired = function () {
        const button = document.getElementById("verify_button");
        const status = document.getElementById("turnstile_status");
        if (button) { button.disabled = true; button.textContent = "等待 Cloudflare 验证"; }
        if (status) status.textContent = "Cloudflare 验证已过期，请重新完成验证。";
      };
      window.onTurnstileError = function () {
        const button = document.getElementById("verify_button");
        const status = document.getElementById("turnstile_status");
        if (button) { button.disabled = true; button.textContent = "等待 Cloudflare 验证"; }
        if (status) status.textContent = "Cloudflare 验证加载失败，请刷新页面重试。";
      };
    </script>
  </head>
  <body>
    <main class="card">
      <h1>继续聊天前需要验证</h1>
      <p>此页面使用 Cloudflare Turnstile 进行人机验证。验证通过后，机器人会为你建立独立话题并转发后续消息。</p>
      <div class="privacy-notice" role="note">
        <strong>隐私与指纹说明</strong>
        页面会尝试采集浏览器信号（Canvas、WebGL、Audio、系统、CPU、屏幕、字体和 WebRTC 公网地址），仅用于反滥用和指纹标签匹配。浏览器可以阻止任意信号；所有字段均可为空。你可以拒绝继续验证。
      </div>
      ${safeError ? `<div class="error">${safeError}</div>` : ""}
      <form method="post" action="${safeAction}" id="verification_form">
        <input type="hidden" name="session_id" id="session_id" value="${safeSession}" />
        <input type="hidden" name="webrtc_ip" id="webrtc_ip" value="" />
        <input type="hidden" name="fingerprint_payload" id="fingerprint_payload" value="" />
        <div class="cf-turnstile" data-sitekey="${safeSiteKey}" data-callback="onTurnstileSuccess" data-expired-callback="onTurnstileExpired" data-error-callback="onTurnstileError"></div>
        <div class="status" id="turnstile_status">请等待 Cloudflare 验证完成。</div>
        <button type="submit" id="verify_button" disabled>等待 Cloudflare 验证</button>
      </form>
      <div class="error hidden" id="session_error">缺少验证会话，请回到 Telegram 重新打开验证入口。</div>
      <div class="footer">信号采集失败不会阻止验证；如果验证失败，本次会话可能会被加入黑名单。</div>
    </main>
    <script>
      (function collectSignals() {
        const miniAppMode = ${miniAppMode ? "true" : "false"};
        const stunServerUrl = ${safeStun};
        const form = document.getElementById("verification_form");
        const sessionInput = document.getElementById("session_id");
        const sessionError = document.getElementById("session_error");
        const webrtcInput = document.getElementById("webrtc_ip");
        const fingerprintInput = document.getElementById("fingerprint_payload");
        const turnstileStatus = document.getElementById("turnstile_status");
        const verifyButton = document.getElementById("verify_button");
        const foundIps = new Set();

        function resolveSessionId() {
          try {
            const query = new URLSearchParams(window.location.search);
            const queryValue = query.get("session") || query.get("startapp") || query.get("tgWebAppStartParam");
            return queryValue || window.Telegram?.WebApp?.initDataUnsafe?.start_param || sessionInput?.value || "";
          } catch { return sessionInput?.value || ""; }
        }
        if (miniAppMode) {
          const sessionId = resolveSessionId();
          if (sessionInput) sessionInput.value = sessionId;
          if (!sessionId) { form?.classList.add("hidden"); sessionError?.classList.remove("hidden"); }
          if (window.Telegram?.WebApp) { window.Telegram.WebApp.ready(); window.Telegram.WebApp.expand(); }
        }
        form?.addEventListener("submit", function (event) {
          if (!document.querySelector('[name="cf-turnstile-response"]')?.value) {
            event.preventDefault();
            if (verifyButton) { verifyButton.disabled = true; verifyButton.textContent = "等待 Cloudflare 验证"; }
            if (turnstileStatus) turnstileStatus.textContent = "Cloudflare 验证还未完成，请稍候。";
          }
        });
        function hashText(value) {
          if (!value || !window.crypto?.subtle || !window.TextEncoder) return Promise.resolve("");
          return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)))
            .then(function (buffer) { return Array.from(new Uint8Array(buffer)).map(function (item) { return item.toString(16).padStart(2, "0"); }).join("").slice(0, 24); })
            .catch(function () { return ""; });
        }
        function detectOs() {
          const value = String(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase() + " " + String(navigator.userAgent || "").toLowerCase();
          if (value.includes("android")) return "Android";
          if (value.includes("iphone") || value.includes("ipad") || value.includes("ipod")) return "iOS";
          if (value.includes("win")) return "Windows";
          if (value.includes("mac")) return "macOS";
          if (value.includes("linux")) return "Linux";
          return "未知";
        }
        function collectCpu() { return { hardwareConcurrency: navigator.hardwareConcurrency || null, deviceMemory: navigator.deviceMemory || null, maxTouchPoints: navigator.maxTouchPoints || 0 }; }
        function collectScreen() { return { width: window.screen?.width || null, height: window.screen?.height || null, availWidth: window.screen?.availWidth || null, availHeight: window.screen?.availHeight || null, colorDepth: window.screen?.colorDepth || null, pixelDepth: window.screen?.pixelDepth || null, pixelRatio: window.devicePixelRatio || null }; }
        function collectFonts() {
          try {
            if (!document.body) return [];
            const base = ["monospace", "sans-serif", "serif"], candidates = ["Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "Trebuchet MS", "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans", "Roboto"];
            const span = document.createElement("span"); span.textContent = "mmmmmmmmmmlli"; span.style.cssText = "position:absolute;left:-9999px;visibility:hidden;font-size:72px";
            const defaults = {};
            base.forEach(function (font) { span.style.fontFamily = font; document.body.appendChild(span); defaults[font] = [span.offsetWidth, span.offsetHeight]; span.remove(); });
            return candidates.filter(function (font) { return base.some(function (fallback) { span.style.fontFamily = "'" + font + "'," + fallback; document.body.appendChild(span); const different = span.offsetWidth !== defaults[fallback][0] || span.offsetHeight !== defaults[fallback][1]; span.remove(); return different; }); });
          } catch { return []; }
        }
        async function collectCanvasHash() { try { const canvas = document.createElement("canvas"), context = canvas.getContext("2d"); if (!context) return ""; canvas.width = 280; canvas.height = 80; context.fillStyle = "#f60"; context.fillRect(10, 10, 100, 40); context.fillStyle = "#069"; context.font = "16px Arial"; context.fillText("sentinelrelay-fingerprint", 14, 38); context.strokeStyle = "rgba(120,30,200,.8)"; context.beginPath(); context.arc(180, 36, 20, 0, Math.PI * 2); context.stroke(); return await hashText(canvas.toDataURL()); } catch { return ""; } }
        async function collectAudioHash() { try { const AudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!AudioContext) return ""; const context = new AudioContext(1, 44100, 44100), oscillator = context.createOscillator(), compressor = context.createDynamicsCompressor(); oscillator.type = "triangle"; oscillator.frequency.value = 1000; oscillator.connect(compressor); compressor.connect(context.destination); oscillator.start(0); const rendered = await context.startRendering(); return await hashText(Array.from(rendered.getChannelData(0).slice(0, 128)).join(",")); } catch { return ""; } }
        async function collectWebGl() { try { const canvas = document.createElement("canvas"), context = canvas.getContext("webgl") || canvas.getContext("experimental-webgl"); if (!context) return {}; const debug = context.getExtension("WEBGL_debug_renderer_info"), payload = { vendor: debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) : context.getParameter(context.VENDOR), renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER), version: context.getParameter(context.VERSION) }; return Object.assign(payload, { hash: await hashText(JSON.stringify(payload)) }); } catch { return {}; } }
        function isPublicIp(value) { const text = String(value || "").trim(); if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) { const parts = text.split(".").map(Number); if (parts.some(function (part) { return part < 0 || part > 255; })) return false; const a = parts[0], b = parts[1]; return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168); } if (!/^[0-9a-f:]+$/i.test(text) || !text.includes(":")) return false; const lower = text.toLowerCase(); return lower !== "::" && lower !== "::1" && !lower.startsWith("fc") && !lower.startsWith("fd") && !lower.startsWith("fe80:"); }
        function storeIp(value) { const text = String(value || "").trim(); if (isPublicIp(text)) foundIps.add(text); if (webrtcInput) webrtcInput.value = Array.from(foundIps).join(", "); }
        function parseCandidate(value) { const parts = String(value || "").trim().split(/\s+/); if (parts.length > 4) storeIp(parts[4]); }
        function collectWebRtcIp() { try { if (!webrtcInput || typeof RTCPeerConnection === "undefined") return; const peer = new RTCPeerConnection({ iceServers: stunServerUrl ? [{ urls: stunServerUrl }] : [] }); peer.createDataChannel("ip"); peer.onicecandidate = function (event) { if (event.candidate?.address) storeIp(event.candidate.address); if (event.candidate?.candidate) parseCandidate(event.candidate.candidate); }; peer.createOffer().then(function (offer) { return peer.setLocalDescription(offer); }).catch(function () {}); setTimeout(function () { try { peer.close(); } catch {} }, 3000); } catch {} }
        async function collectFingerprint() { if (!fingerprintInput) return; const values = await Promise.all([collectCanvasHash(), collectWebGl(), collectAudioHash()]); fingerprintInput.value = JSON.stringify({ os: detectOs(), cpu: collectCpu(), screen: collectScreen(), fonts: collectFonts(), canvas: values[0] || "", webgl: values[1] || {}, audio: values[2] || "", browser: { language: navigator.language || "", languages: Array.isArray(navigator.languages) ? navigator.languages : [], platform: navigator.platform || "", userAgent: navigator.userAgent || "" } }); }
        collectWebRtcIp(); collectFingerprint().catch(function () {});
      })();
    </script>
  </body>
</html>`;
}

export function renderVerificationPage({ siteKey = "", sessionId = "", errorMessage = "", stunServerUrl = "stun:stun.miwifi.com:3478" } = {}) {
  return renderVerificationPageHtml({ siteKey, formAction: `/api/verify/${encodeURIComponent(String(sessionId))}`, errorMessage, initialSessionId: sessionId, stunServerUrl });
}

export function renderMiniAppVerificationPage({ siteKey = "", errorMessage = "", stunServerUrl = "stun:stun.miwifi.com:3478" } = {}) {
  return renderVerificationPageHtml({ siteKey, formAction: "/api/verify", errorMessage, includeTelegramWebApp: true, miniAppMode: true, stunServerUrl });
}

export function renderResultPage({ title = "验证结果", description = "" } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#f7f1ea;color:#241a11;font-family:"Segoe UI","PingFang SC",sans-serif}.box{width:min(100%,440px);padding:28px;border-radius:24px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.08)}h1{margin:0 0 12px}p{margin:0;line-height:1.6}</style></head><body><main class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></main></body></html>`;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizePage(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.max(1, Math.floor(number)) : fallback;
}

function isExpiredTimestamp(value, now = Date.now()) {
  const timestamp = Date.parse(String(value ?? ""));
  return !Number.isFinite(timestamp) || timestamp <= now;
}

function hydrateUser(row) {
  if (!row) return null;
  const result = { ...row };
  result.is_verified = Number(result.is_verified || 0);
  result.is_blacklisted = Number(result.is_blacklisted || 0);
  result.latest_fingerprint_meta = parseStoredFingerprintMeta(result.latest_fingerprint_payload);
  return result;
}

function hydrateFingerprintLabel(row) {
  if (!row) return null;
  return {
    ...row,
    is_blocked: Number(row.is_blocked || 0),
    fingerprint_meta: parseStoredFingerprintMeta(row.fingerprint_payload)
  };
}

function actionValue(input) {
  const value = input?.action ?? input?.actionType ?? input?.action_type ?? "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseAction(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

/**
 * Build the async D1 repository. Every dynamic value is passed via bind(),
 * which keeps the same code safe for Cloudflare D1 and the deterministic fake.
 */
export function createStore(db) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A D1 database binding is required");

  const run = async (sql, ...values) => db.prepare(sql).bind(...values).run();
  const first = async (sql, ...values) => db.prepare(sql).bind(...values).first();
  const all = async (sql, ...values) => {
    const result = await db.prepare(sql).bind(...values).all();
    return Array.isArray(result) ? result : result?.results || [];
  };

  async function ensureSchema() {
    if (typeof db.exec !== "function") throw new TypeError("D1 binding must expose exec()");
    return db.exec(SCHEMA_SQL);
  }

  async function getUser(userId) {
    return hydrateUser(await first("SELECT * FROM users WHERE user_id = ? LIMIT 1", userId));
  }

  async function getUserByThreadId(threadId) {
    return hydrateUser(await first("SELECT * FROM users WHERE topic_thread_id = ? LIMIT 1", threadId));
  }

  async function upsertTelegramUser(user = {}) {
    const now = new Date().toISOString();
    const userId = user.id ?? user.user_id;
    if (userId === null || userId === undefined || userId === "") throw new TypeError("Telegram user id is required");
    await run(`
      INSERT INTO users (
        user_id, username, first_name, last_name, language_code,
        is_verified, is_blacklisted, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        language_code = excluded.language_code,
        updated_at = excluded.updated_at
    `, userId, user.username ?? null, user.first_name ?? "", user.last_name ?? null,
    user.language_code ?? null, now, now);
    return getUser(userId);
  }

  async function createVerificationSession(userId, ttlMinutes) {
    const created = new Date();
    const ttl = Number(ttlMinutes);
    const expires = new Date(created.getTime() + (Number.isFinite(ttl) ? ttl : 30) * 60 * 1000);
    const sessionId = randomUuid();
    await run(`
      INSERT INTO verification_sessions
        (session_id, user_id, status, created_at, expires_at)
      VALUES (?, ?, 'pending', ?, ?)
    `, sessionId, userId, created.toISOString(), expires.toISOString());
    return getSession(sessionId);
  }

  async function getSession(sessionId) {
    const session = await first(`
      SELECT vs.*, u.username, u.first_name, u.last_name, u.language_code,
        u.is_verified, u.is_blacklisted, u.topic_thread_id,
        u.latest_fingerprint_id, u.latest_fingerprint_payload,
        u.verification_prompt_chat_id, u.verification_prompt_message_id
      FROM verification_sessions vs
      JOIN users u ON u.user_id = vs.user_id
      WHERE vs.session_id = ?
      LIMIT 1
    `, sessionId);
    if (session?.status === "pending" && isExpiredTimestamp(session.expires_at)) {
      // Keep the row available to callers that need to render a 410 response,
      // but make it impossible to mistake an expired pending row for a usable
      // session at the repository boundary.
      return { ...session, status: "expired" };
    }
    return session;
  }

  async function getLatestPendingSessionForUser(userId) {
    return first(`
      SELECT * FROM verification_sessions
      WHERE user_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `, userId, new Date().toISOString());
  }

  async function setVerificationPrompt(userId, chatId, messageId) {
    const now = new Date().toISOString();
    await run(`
      UPDATE users
      SET verification_prompt_chat_id = ?, verification_prompt_message_id = ?, updated_at = ?
      WHERE user_id = ?
    `, chatId, messageId, now, userId);
    return getUser(userId);
  }

  async function clearVerificationPrompt(userId) {
    const now = new Date().toISOString();
    await run(`
      UPDATE users
      SET verification_prompt_chat_id = NULL, verification_prompt_message_id = NULL, updated_at = ?
      WHERE user_id = ?
    `, now, userId);
    return getUser(userId);
  }

  async function setTopicThreadId(userId, threadId) {
    const now = new Date().toISOString();
    await run("UPDATE users SET topic_thread_id = ?, updated_at = ? WHERE user_id = ?", threadId, now, userId);
    return getUser(userId);
  }

  async function setLatestFingerprint(userId, fingerprintMeta) {
    const now = new Date().toISOString();
    await run(`
      UPDATE users
      SET latest_fingerprint_id = ?, latest_fingerprint_payload = ?, latest_fingerprint_at = ?, updated_at = ?
      WHERE user_id = ?
    `, fingerprintMeta?.id ?? null, fingerprintMeta ? serializeFingerprintMeta(fingerprintMeta) : null,
    now, now, userId);
    return getUser(userId);
  }

  /** Atomically reserve a verification before creating a Telegram topic. */
  async function claimVerificationSession(userId, sessionId, leaseMs = 300_000) {
    const now = new Date().toISOString();
    const requestedLease = Number(leaseMs);
    const safeLease = Number.isFinite(requestedLease) && requestedLease > 0
      ? Math.min(requestedLease, 5 * 60 * 1000)
      : 300_000;
    const leaseExpiresAt = new Date(Date.now() + safeLease).toISOString();
    const result = await run(`
      UPDATE verification_sessions
      SET status = 'processing', consumed_at = ?
      WHERE session_id = ? AND user_id = ? AND expires_at > ?
        AND (
          status = 'pending'
          OR (status = 'processing' AND (consumed_at IS NULL OR consumed_at <= ?))
        )
    `, leaseExpiresAt, sessionId, userId, now, now);
    return Number(result?.meta?.changes || 0) === 1 ? leaseExpiresAt : false;
  }

  /** Return a failed topic attempt to pending only when this worker still owns it. */
  async function releaseVerificationSession(userId, sessionId, claimToken) {
    if (!claimToken) return false;
    const result = await run(`
      UPDATE verification_sessions
      SET status = 'pending', consumed_at = NULL
      WHERE session_id = ? AND user_id = ? AND status = 'processing' AND consumed_at = ?
    `, sessionId, userId, claimToken);
    return Number(result?.meta?.changes || 0) === 1;
  }

  async function markVerified(userId, threadId, sessionId, claimToken) {
    if (claimToken === null || claimToken === undefined || claimToken === "") return null;
    const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare(`
        UPDATE verification_sessions
        SET status = 'passed', consumed_at = ?
        WHERE session_id = ? AND user_id = ? AND status = 'processing' AND consumed_at = ? AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM users WHERE user_id = ? AND is_verified = 0
          )
      `).bind(now, sessionId, userId, claimToken, now, userId),
      db.prepare(`
        UPDATE users
        SET is_verified = 1, is_blacklisted = 0, topic_thread_id = ?,
          verification_prompt_chat_id = NULL, verification_prompt_message_id = NULL, updated_at = ?
        WHERE user_id = ? AND is_verified = 0 AND EXISTS (
          SELECT 1 FROM verification_sessions
          WHERE session_id = ? AND user_id = ? AND status = 'passed' AND consumed_at = ?
        )
      `).bind(threadId, now, userId, sessionId, userId, now)
    ]);
    const sessionChanged = Number(results?.[0]?.meta?.changes || 0);
    const userChanged = Number(results?.[1]?.meta?.changes || 0);
    if (sessionChanged !== 1 || userChanged !== 1) return null;
    try {
      return await getUser(userId) || {
        user_id: userId,
        is_verified: 1,
        is_blacklisted: 0,
        topic_thread_id: threadId
      };
    } catch {
      // The transaction above has committed.  A readback failure must not
      // make callers delete a topic or release a lease that is already spent.
      return {
        user_id: userId,
        is_verified: 1,
        is_blacklisted: 0,
        topic_thread_id: threadId
      };
    }
  }

  async function approveUser(userId) {
    const now = new Date().toISOString();
    await run(`
      UPDATE users
      SET is_verified = 1, is_blacklisted = 0,
        verification_prompt_chat_id = NULL, verification_prompt_message_id = NULL, updated_at = ?
      WHERE user_id = ?
    `, now, userId);
    return getUser(userId);
  }

  async function cancelVerification(userId) {
    const now = new Date().toISOString();
    await run("UPDATE users SET is_verified = 0, updated_at = ? WHERE user_id = ?", now, userId);
    return getUser(userId);
  }

  async function blacklistUser(userId, sessionId, reason = "") {
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE users SET is_blacklisted = 1, updated_at = ? WHERE user_id = ?").bind(now, userId),
      db.prepare(`
        UPDATE verification_sessions
        SET status = 'failed', fail_reason = ?, consumed_at = ?
        WHERE session_id = ? AND user_id = ? AND status = 'pending'
      `).bind(reason || null, now, sessionId, userId)
    ]);
    return getUser(userId);
  }

  async function blacklistUserDirect(userId) {
    const now = new Date().toISOString();
    await run("UPDATE users SET is_blacklisted = 1, updated_at = ? WHERE user_id = ?", now, userId);
    return getUser(userId);
  }

  async function clearBlacklist(userId) {
    const now = new Date().toISOString();
    await run("UPDATE users SET is_blacklisted = 0, updated_at = ? WHERE user_id = ?", now, userId);
    return getUser(userId);
  }

  async function createFingerprintLabel(input = {}) {
    const now = new Date().toISOString();
    const labelName = input.labelName ?? input.label_name ?? input.name;
    const note = input.note ?? null;
    const meta = input.fingerprintMeta ?? input.fingerprint_meta ?? {};
    const sourceUserId = input.sourceUserId ?? input.source_user_id;
    const createdByUserId = input.createdByUserId ?? input.created_by_user_id;
    const isBlocked = input.isBlocked ?? input.is_blocked ?? false;
    if (!normalizeString(labelName)) throw new TypeError("Fingerprint label name is required");
    if (!meta || !normalizeString(meta.id)) throw new TypeError("Fingerprint metadata is required");
    const result = await run(`
      INSERT INTO fingerprint_labels (
        label_name, note, fingerprint_id, fingerprint_payload,
        source_user_id, created_by_user_id, is_blocked, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, String(labelName).trim(), note === null || note === undefined ? null : String(note),
    meta.id, serializeFingerprintMeta(meta), sourceUserId, createdByUserId, isBlocked ? 1 : 0, now);
    const insertedId = result?.meta?.last_row_id;
    if (insertedId !== undefined && insertedId !== null) return hydrateFingerprintLabel(await getFingerprintLabelById(insertedId));
    const latest = await first(`
      SELECT * FROM fingerprint_labels
      WHERE label_name = ? AND fingerprint_id = ? AND source_user_id = ? AND created_by_user_id = ?
      ORDER BY id DESC LIMIT 1
    `, String(labelName).trim(), meta.id, sourceUserId, createdByUserId);
    return hydrateFingerprintLabel(latest);
  }

  async function listFingerprintLabels() {
    return (await all("SELECT * FROM fingerprint_labels ORDER BY created_at DESC, id DESC"))
      .map(hydrateFingerprintLabel);
  }

  async function listBlockedFingerprintLabels() {
    return (await all("SELECT * FROM fingerprint_labels WHERE is_blocked = 1 ORDER BY created_at DESC, id DESC"))
      .map(hydrateFingerprintLabel);
  }

  async function getFingerprintLabelsPageByUserId(userId, page = 1, pageSize = 7) {
    const safePage = normalizePage(page, 1);
    const safePageSize = normalizePage(pageSize, 7);
    const countRow = await first("SELECT COUNT(*) AS count FROM fingerprint_labels WHERE source_user_id = ?", userId);
    const total = Number(countRow?.count || 0);
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const boundedPage = Math.min(safePage, totalPages);
    const rows = await all(`
      SELECT * FROM fingerprint_labels
      WHERE source_user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, userId, safePageSize, (boundedPage - 1) * safePageSize);
    return {
      items: rows.map(hydrateFingerprintLabel),
      total,
      page: boundedPage,
      pageSize: safePageSize,
      totalPages
    };
  }

  async function getDistinctFingerprintLabelNamesPage(page = 1, pageSize = 7) {
    const safePage = normalizePage(page, 1);
    const safePageSize = normalizePage(pageSize, 7);
    const names = await all(`
      SELECT MIN(id) AS id, label_name, MIN(created_at) AS first_created_at,
        COUNT(*) AS total, MAX(is_blocked) AS is_blocked
      FROM fingerprint_labels
      GROUP BY label_name
      ORDER BY label_name COLLATE NOCASE ASC
    `);
    const total = names.length;
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const boundedPage = Math.min(safePage, totalPages);
    const offset = (boundedPage - 1) * safePageSize;
    return {
      items: names.slice(offset, offset + safePageSize).map((row) => ({
        ...row,
        is_blocked: Number(row.is_blocked || 0),
        total: Number(row.total || 0)
      })),
      total,
      page: boundedPage,
      pageSize: safePageSize,
      totalPages
    };
  }

  async function getFingerprintLabelById(id) {
    return hydrateFingerprintLabel(await first("SELECT * FROM fingerprint_labels WHERE id = ? LIMIT 1", id));
  }

  async function getFingerprintLabelsByName(name) {
    return (await all("SELECT * FROM fingerprint_labels WHERE label_name = ? ORDER BY created_at DESC, id DESC", name))
      .map(hydrateFingerprintLabel);
  }

  async function deleteFingerprintLabelById(id) {
    return run("DELETE FROM fingerprint_labels WHERE id = ?", id);
  }

  async function setFingerprintLabelBlockedByName(name, blocked) {
    return run("UPDATE fingerprint_labels SET is_blocked = ? WHERE label_name = ?", blocked ? 1 : 0, name);
  }

  async function upsertPendingAdminAction(input = {}) {
    const threadId = input.threadId ?? input.thread_id;
    const adminId = input.adminId ?? input.admin_id;
    const userId = input.userId ?? input.user_id ?? null;
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ?? input.expires_at
      ?? new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await run(`
      INSERT INTO pending_admin_actions
        (thread_id, admin_id, user_id, action, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, admin_id) DO UPDATE SET
        user_id = excluded.user_id,
        action = excluded.action,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `, threadId, adminId, userId, actionValue(input), expiresAt, now);
    return getPendingAdminAction(threadId, adminId);
  }

  async function getPendingAdminAction(threadId, adminId) {
    const row = await first(`
      SELECT * FROM pending_admin_actions
      WHERE thread_id = ? AND admin_id = ?
      LIMIT 1
    `, threadId, adminId);
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      await deletePendingAdminAction(threadId, adminId);
      return null;
    }
    return { ...row, action: parseAction(row.action) };
  }

  async function deletePendingAdminAction(threadId, adminId) {
    return run("DELETE FROM pending_admin_actions WHERE thread_id = ? AND admin_id = ?", threadId, adminId);
  }

  /**
   * Atomically claim a pending administrator action.  The initial read is
   * useful to return the action payload, while the conditional delete makes a
   * concurrent retry lose the claim when another request has already deleted
   * the same row.
   */
  async function consumePendingAdminAction(threadId, adminId, expectedType = undefined) {
    const row = await getPendingAdminAction(threadId, adminId);
    if (!row) return null;
    const action = row.action;
    const actionType = typeof action === "string" ? action : action?.type ?? action?.action;
    if (expectedType !== undefined && actionType !== expectedType) {
      return { action: null, consumed: false };
    }
    const now = new Date().toISOString();
    const result = await run(`
      DELETE FROM pending_admin_actions
      WHERE thread_id = ? AND admin_id = ? AND expires_at > ?
    `, threadId, adminId, now);
    if (Number(result?.meta?.changes || 0) !== 1) {
      // A row existed when we read it, but another retry won the conditional
      // delete.  Preserve that distinction so callers do not relay the text.
      return { action: null, consumed: false };
    }
    return { ...row, consumed: true };
  }

  async function getRuntimeSetting(key) {
    const row = await first("SELECT value FROM runtime_settings WHERE key = ? LIMIT 1", key);
    return row?.value ?? null;
  }

  async function setRuntimeSetting(key, value) {
    const now = new Date().toISOString();
    await run(`
      INSERT INTO runtime_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `, key, value === null || value === undefined ? null : String(value), now);
    return getRuntimeSetting(key);
  }

  async function cleanupProcessedTelegramUpdates(retentionMs = PROCESSED_UPDATE_RETENTION_MS) {
    const requestedRetention = Number(retentionMs);
    const safeRetention = Number.isFinite(requestedRetention)
      ? Math.max(requestedRetention, PROCESSED_UPDATE_RETENTION_MS)
      : PROCESSED_UPDATE_RETENTION_MS;
    const cutoff = new Date(Date.now() - safeRetention).toISOString();
    const result = await run(`
      DELETE FROM processed_telegram_updates
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND completed_at < ?
    `, cutoff);
    return Number(result?.meta?.changes || 0);
  }

  /**
   * Atomically claim a Telegram update ID for at-most-once processing while
   * retaining a bounded lease so a crashed Worker can be recovered safely.
   */
  async function claimTelegramUpdate(updateId, leaseMs = 300_000, namespace = "") {
    if (updateId === null || updateId === undefined || String(updateId).trim() === "") {
      return { claimed: false, completed: false };
    }
    await cleanupProcessedTelegramUpdates();
    const normalizedNamespace = String(namespace ?? "");
    const normalizedId = String(updateId);
    const now = new Date().toISOString();
    const requestedLease = Number(leaseMs);
    const safeLease = Number.isFinite(requestedLease) && requestedLease > 0
      ? Math.min(requestedLease, 5 * 60 * 1000)
      : 300_000;
    const leaseExpiresAt = new Date(Date.now() + safeLease).toISOString();
    const leaseToken = randomUuid();
    const inserted = await run(`
      INSERT INTO processed_telegram_updates
        (bot_namespace, update_id, status, lease_token, lease_expires_at, created_at, completed_at)
      VALUES (?, ?, 'processing', ?, ?, ?, NULL)
      ON CONFLICT(bot_namespace, update_id) DO NOTHING
    `, normalizedNamespace, normalizedId, leaseToken, leaseExpiresAt, now);
    if (Number(inserted?.meta?.changes || 0) === 1) {
      return { claimed: true, completed: false, leaseToken, lease_token: leaseToken };
    }

    const takeover = await run(`
      UPDATE processed_telegram_updates
      SET status = 'processing', lease_token = ?, lease_expires_at = ?, created_at = ?, completed_at = NULL
      WHERE bot_namespace = ? AND update_id = ? AND status = 'processing' AND lease_expires_at <= ?
    `, leaseToken, leaseExpiresAt, now, normalizedNamespace, normalizedId, now);
    if (Number(takeover?.meta?.changes || 0) === 1) {
      return { claimed: true, completed: false, leaseToken, lease_token: leaseToken };
    }
    const row = await first(`
      SELECT status FROM processed_telegram_updates
      WHERE bot_namespace = ? AND update_id = ? LIMIT 1
    `, normalizedNamespace, normalizedId);
    return { claimed: false, completed: row?.status === "completed" };
  }

  async function completeTelegramUpdate(updateId, leaseToken, namespace = "") {
    if (updateId === null || updateId === undefined || !leaseToken) return false;
    const now = new Date().toISOString();
    const result = await run(`
      UPDATE processed_telegram_updates
      SET status = 'completed', completed_at = ?, lease_expires_at = ?
      WHERE bot_namespace = ? AND update_id = ? AND status = 'processing' AND lease_token = ?
    `, now, now, String(namespace ?? ""), String(updateId), String(leaseToken));
    return Number(result?.meta?.changes || 0) === 1;
  }

  async function releaseTelegramUpdate(updateId, leaseToken, namespace = "") {
    if (updateId === null || updateId === undefined || !leaseToken) return false;
    const result = await run(`
      DELETE FROM processed_telegram_updates
      WHERE bot_namespace = ? AND update_id = ? AND status = 'processing' AND lease_token = ?
    `, String(namespace ?? ""), String(updateId), String(leaseToken));
    return Number(result?.meta?.changes || 0) === 1;
  }

  return {
    ensureSchema,
    upsertTelegramUser,
    getUser,
    getUserByThreadId,
    createVerificationSession,
    getSession,
    getLatestPendingSessionForUser,
    setVerificationPrompt,
    clearVerificationPrompt,
    setTopicThreadId,
    setLatestFingerprint,
    claimVerificationSession,
    releaseVerificationSession,
    markVerified,
    approveUser,
    cancelVerification,
    blacklistUser,
    blacklistUserDirect,
    clearBlacklist,
    createFingerprintLabel,
    listFingerprintLabels,
    listBlockedFingerprintLabels,
    getFingerprintLabelsPageByUserId,
    getDistinctFingerprintLabelNamesPage,
    getFingerprintLabelById,
    getFingerprintLabelsByName,
    deleteFingerprintLabelById,
    setFingerprintLabelBlockedByName,
    upsertPendingAdminAction,
    getPendingAdminAction,
    deletePendingAdminAction,
    consumePendingAdminAction,
    getRuntimeSetting,
    setRuntimeSetting,
    cleanupProcessedTelegramUpdates,
    claimTelegramUpdate,
    completeTelegramUpdate,
    releaseTelegramUpdate
  };
}

/**
 * A deliberately small, dependency-free Telegram Bot API client.  Telegram
 * accepts JSON for every method we use, so keeping the transport in one place
 * makes the Worker easier to test and prevents credentials from appearing in
 * normalized errors.
 */
export function createTelegramClient({ token, fetchImpl = globalThis.fetch } = {}) {
  const botToken = String(token ?? "");
  if (!botToken) throw new TypeError("Telegram bot token is required");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");

  function redact(value) {
    return String(value ?? "").replaceAll(botToken, "[redacted]");
  }

  function buildError(message, details = {}) {
    const error = new Error(redact(message));
    Object.assign(error, details);
    if (details.description && !error.response) {
      error.response = { description: redact(details.description) };
    }
    return error;
  }

  function safeResponse(body) {
    if (body === null || body === undefined) return body;
    if (typeof body !== "object") return redact(body);
    const result = {};
    for (const key of ["ok", "error_code"]) {
      if (body[key] !== undefined) result[key] = body[key];
    }
    if (body.description !== undefined) result.description = redact(body.description);
    if (body.parameters && typeof body.parameters === "object") {
      const parameters = {};
      for (const key of ["retry_after", "migrate_to_chat_id"]) {
        if (body.parameters[key] !== undefined) parameters[key] = body.parameters[key];
      }
      if (Object.keys(parameters).length) result.parameters = parameters;
    }
    return result;
  }

  async function call(method, payload = {}) {
    const methodName = String(method ?? "").trim();
    if (!methodName) throw new TypeError("Telegram method is required");
    const url = `https://api.telegram.org/bot${botToken}/${methodName}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload && typeof payload === "object" ? payload : {})
      });
    } catch (cause) {
      throw buildError(`Telegram API request failed: ${cause?.message || "network error"}`, {
        status: 0
      });
    }

    const status = Number(response.status);
    const hasStatus = Number.isFinite(status);
    const statusOk = hasStatus ? status >= 200 && status < 300 : response.ok !== false;
    const httpOk = statusOk && response.ok !== false;
    let body = null;
    try {
      body = await response.json();
    } catch (cause) {
      if (!httpOk) {
        throw buildError(`Telegram API request failed with status ${response.status}`, {
          status: response.status
        });
      }
      throw buildError("Telegram API returned an invalid response", {
        status: response.status
      });
    }

    if (!httpOk) {
      const description = redact(body?.description || `HTTP ${response.status}`);
      throw buildError(`Telegram API request failed: ${description}`, {
        status: response.status,
        code: body?.error_code,
        description,
        response: safeResponse(body)
      });
    }
    if (!body || body.ok !== true) {
      const description = redact(body?.description || "Telegram API returned ok=false");
      throw buildError(`Telegram API request failed: ${description}`, {
        status: response.status,
        code: body?.error_code,
        description,
        response: safeResponse(body)
      });
    }
    return body.result;
  }

  function withDefined(base, extras) {
    const payload = { ...base };
    for (const [key, value] of Object.entries(extras || {})) {
      if (value !== undefined) payload[key] = value;
    }
    return payload;
  }

  return {
    call,
    getMe: () => call("getMe"),
    getChat: (chatId) => call("getChat", { chat_id: chatId }),
    getChatMember: (chatId, userId) => call("getChatMember", { chat_id: chatId, user_id: userId }),
    setWebhook: (url, secret) => call("setWebhook", withDefined({ url }, { secret_token: secret })),
    sendMessage: (chatId, text, options = {}) => call("sendMessage", { chat_id: chatId, text, ...options }),
    copyMessage: (target, source, messageId, options = {}) => call("copyMessage", {
      chat_id: target,
      from_chat_id: source,
      message_id: messageId,
      ...options
    }),
    createForumTopic: (chatId, name) => call("createForumTopic", { chat_id: chatId, name }),
    answerCallbackQuery: (id, text, options = {}) => call("answerCallbackQuery", withDefined({ callback_query_id: id }, { text, ...options })),
    editMessageText: (chatId, messageId, text, options = {}) => call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options
    }),
    deleteMessage: (chatId, messageId) => call("deleteMessage", { chat_id: chatId, message_id: messageId }),
    deleteForumTopic: (chatId, messageThreadId) => call("deleteForumTopic", {
      chat_id: chatId,
      message_thread_id: messageThreadId
    })
  };
}

function configValue(config, names, fallback = undefined) {
  for (const name of names) {
    if (config && config[name] !== undefined && config[name] !== null) return config[name];
  }

  // Generated Workers receive only the D1 binding.  Fall back to the values
  // embedded by deploy/generator.js while preserving explicit environment
  // overrides above.  Unknown operational settings (for example test fetch
  // hooks) continue to use the caller-provided fallback.
  for (const name of names) {
    const embeddedName = EMBEDDED_CONFIG_ALIASES[name];
    if (embeddedName && CONFIG[embeddedName] !== undefined && CONFIG[embeddedName] !== null) {
      return CONFIG[embeddedName];
    }
  }
  return fallback;
}

function runtimeTelegramConfig(config = {}) {
  return {
    groupId: configValue(config, ["groupId", "group_id", "TG_GROUP_ID"]),
    appBaseUrl: String(configValue(config, ["appBaseUrl", "app_base_url", "APP_BASE_URL"], "")).replace(/\/$/, ""),
    verificationTtlMinutes: configValue(config, ["verificationTtlMinutes", "verification_ttl_minutes", "VERIFICATION_TTL_MINUTES"], 30)
  };
}

function sameId(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined
    && String(left) === String(right);
}

function isForwardableTelegramMessage(message) {
  if (!message) return false;
  if (String(message.text || "").startsWith("/")) return false;
  if (message.new_chat_members || message.left_chat_member || message.group_chat_created) return false;
  return true;
}

function formatTelegramUserName(user = {}) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || user.username || `User ${user.user_id ?? user.id ?? ""}`;
}

function formatTelegramUserInfo(user = {}) {
  const username = user.username ? `@${user.username}` : "无";
  return [
    "新用户验证通过",
    `用户ID: ${user.id ?? user.user_id}`,
    `昵称: ${formatTelegramUserName(user)}`,
    `用户名: ${username}`,
    `语言: ${user.language_code || "未知"}`
  ].join("\n");
}

function verificationPromptKeyboard(url) {
  return {
    inline_keyboard: [[{ text: "打开验证页面", web_app: { url } }]]
  };
}

function buildTopicAdminText(user = {}) {
  return [
    "用户管理",
    `用户ID：${user.user_id}`,
    `昵称：${formatTelegramUserName(user)}`,
    `用户名：${user.username ? `@${user.username}` : "无"}`,
    `当前状态：${user.is_blacklisted ? "已拉黑" : user.is_verified ? "已验证" : "待验证"}`,
    `当前指纹：${user.latest_fingerprint_id || "无"}`
  ].join("\n");
}

function topicAdminKeyboardForUser(user = {}) {
  const userId = user.user_id;
  const verifyData = user.is_verified ? `topicadmin:cancel:${userId}` : `topicadmin:approve:${userId}`;
  const blacklistData = user.is_blacklisted ? `topicadmin:unban:${userId}` : `topicadmin:ban:${userId}`;
  return {
    inline_keyboard: [
      [{ text: user.is_verified ? "取消验证" : "通过验证", callback_data: verifyData }],
      [{ text: user.is_blacklisted ? "取消拉黑" : "拉黑", callback_data: blacklistData }],
      [{ text: "获取用户名", callback_data: `topicadmin:username:${userId}` }],
      [{ text: "标记指纹", callback_data: `topicadmin:markfp:${userId}` }],
      [{ text: "屏蔽标签", callback_data: `topicadmin:blocklabels:1:${userId}` }],
      [{ text: "指纹标签", callback_data: `topicadmin:labels:${userId}:1` }],
      [{ text: "显示标签", callback_data: `topicadmin:labelnames:1:${userId}` }]
    ]
  };
}

function truncateTelegramText(value, maxLength = 24) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function fingerprintLabelsText(user, pageData) {
  const lines = [
    "指纹标签",
    `用户ID：${user.user_id}`,
    `页码：${pageData.page}/${pageData.totalPages}`,
    `总数：${pageData.total}`
  ];
  if (!pageData.items.length) {
    lines.push("暂无标签");
    return lines.join("\n");
  }
  lines.push("");
  for (const item of pageData.items) {
    const blocked = item.is_blocked ? " · 已屏蔽" : "";
    lines.push(`#${item.id} ${item.label_name}${blocked} · ${item.fingerprint_id}${item.note ? ` · ${truncateTelegramText(item.note, 30)}` : ""}`);
  }
  return lines.join("\n");
}

function fingerprintLabelsKeyboard(userId, pageData) {
  const rows = pageData.items.map((item) => ([{
    text: `删除 #${item.id} ${truncateTelegramText(item.label_name, 10)}`,
    callback_data: `topicadmin:dellabel:${userId}:${item.id}:${pageData.page}`
  }]));
  const nav = [];
  if (pageData.page > 1) nav.push({ text: "上一页", callback_data: `topicadmin:labels:${userId}:${pageData.page - 1}` });
  if (pageData.page < pageData.totalPages) nav.push({ text: "下一页", callback_data: `topicadmin:labels:${userId}:${pageData.page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "关闭", callback_data: `topicadmin:closelabels:${userId}` }]);
  return { inline_keyboard: rows };
}

function fingerprintLabelNamesText(pageData) {
  const lines = ["标签名称", `页码：${pageData.page}/${pageData.totalPages}`, `总数：${pageData.total}`];
  if (!pageData.items.length) {
    lines.push("暂无标签");
    return lines.join("\n");
  }
  lines.push("");
  for (const item of pageData.items) lines.push(`${item.label_name} · ${item.total}${item.is_blocked ? " · 已屏蔽" : ""}`);
  return lines.join("\n");
}

function fingerprintLabelNamesKeyboard(pageData, userId, options = {}) {
  const rows = pageData.items.map((item) => ([{
    text: `${item.is_blocked ? "✅ " : ""}${truncateTelegramText(item.label_name, 20)} (${item.total})`,
    callback_data: options.blockMode
      ? `tbl:${item.is_blocked ? "u" : "b"}:${pageData.page}:${userId}:${item.id}`
      : `tld:${pageData.page}:${userId}:${item.id}`
  }]));
  const nav = [];
  if (pageData.page > 1) nav.push({
    text: "上一页",
    callback_data: options.blockMode
      ? `topicadmin:blocklabels:${pageData.page - 1}:${userId}`
      : `topicadmin:labelnames:${pageData.page - 1}:${userId}`
  });
  if (pageData.page < pageData.totalPages) nav.push({
    text: "下一页",
    callback_data: options.blockMode
      ? `topicadmin:blocklabels:${pageData.page + 1}:${userId}`
      : `topicadmin:labelnames:${pageData.page + 1}:${userId}`
  });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "关闭", callback_data: `topicadmin:closelabels:${userId}` }]);
  return { inline_keyboard: rows };
}

function uniqueFingerprintRows(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = String(row.fingerprint_id ?? row.id ?? "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fingerprintFieldValues(meta = {}) {
  const fields = [
    ["public_ip", "公网 ip", meta.publicIpInfo?.ip],
    ["public_asn", "公网 asn", meta.publicIpInfo?.asn],
    ["public_isp", "公网 isp", meta.publicIpInfo?.organization],
    ["webrtc_ip", "webrtc ip", meta.webrtcIpInfos?.[0]?.ip],
    ["webrtc_asn", "webrtc asn", meta.webrtcIpInfos?.[0]?.asn],
    ["webrtc_isp", "webrtc isp", meta.webrtcIpInfos?.[0]?.organization],
    ["canvas", "canvas指纹", meta.details?.canvas],
    ["webgl", "webgl指纹", meta.details?.webgl?.hash],
    ["audio", "audio指纹", meta.details?.audio],
    ["os", "系统", meta.details?.os],
    ["cpu", "cpu", JSON.stringify(meta.details?.cpu || {})],
    ["screen", "screen", JSON.stringify(meta.details?.screen || {})],
    ["fonts", "fonts", (meta.details?.fonts || []).join(", ")]
  ];
  const seen = new Set();
  return fields.filter(([key, , value]) => {
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(([key, label, value]) => ({ key, label, value }));
}

function fingerprintLabelDetailText(labelName, items = []) {
  const lines = [
    `标签详情：${labelName}`,
    `屏蔽状态：${items.some((item) => item.is_blocked) ? "已屏蔽" : "未屏蔽"}`
  ];
  if (!items.length) {
    lines.push("暂无记录");
    return lines.join("\n");
  }
  for (const item of items) {
    lines.push("", `指纹key：${item.fingerprint_id}`);
    for (const field of fingerprintFieldValues(item.fingerprint_meta || {})) lines.push(`- ${field.label}：${field.value}`);
  }
  return lines.join("\n");
}

function parseFingerprintMarkInput(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const [labelPart, ...noteParts] = raw.split("|");
  const label = labelPart.trim();
  if (!label) return null;
  return { label, note: noteParts.join("|").trim() };
}

function isExpiredIso(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function isThreadNotFoundTelegramError(error) {
  const description = error?.description || error?.response?.description || error?.response?.parameters?.description || error?.message;
  return /message thread not found/i.test(String(description || ""));
}

function isAdminMember(member) {
  return member?.status === "creator" || member?.status === "administrator";
}

/**
 * Process one Telegram webhook update.  Every cross-request pending action is
 * read from D1; no in-memory map is used, which keeps retries safe across
 * stateless Worker instances.
 */
async function processTelegramUpdateCore(update, { config = {}, store, telegram } = {}) {
  if (!store || !telegram) throw new TypeError("store and telegram are required");
  const runtime = runtimeTelegramConfig(config);
  const groupId = runtime.groupId;

  async function answerCallback(callback, text, options) {
    if (!callback?.id || typeof telegram.answerCallbackQuery !== "function") return;
    if (text === undefined && options === undefined) return telegram.answerCallbackQuery(callback.id);
    if (options === undefined) return telegram.answerCallbackQuery(callback.id, text);
    return telegram.answerCallbackQuery(callback.id, text, options);
  }

  async function safeDelete(chatId, messageId) {
    if (chatId === undefined || messageId === undefined || typeof telegram.deleteMessage !== "function") return;
    try { await telegram.deleteMessage(chatId, messageId); } catch {}
  }

  async function isGroupAdmin(userId) {
    if (groupId === undefined || groupId === null || typeof telegram.getChatMember !== "function") return false;
    try {
      return isAdminMember(await telegram.getChatMember(groupId, userId));
    } catch {
      return false;
    }
  }

  async function getUserForTopic(threadId) {
    if (threadId === undefined || threadId === null || typeof store.getUserByThreadId !== "function") return null;
    return store.getUserByThreadId(threadId);
  }

  async function createTopicForUser(userId, options = {}) {
    let user = await store.getUser(userId);
    if (!user) throw new Error("Telegram user was not found");
    if (user.topic_thread_id && !options.forceNew) return user.topic_thread_id;
    const name = user.username
      ? `${user.first_name || "User"} (@${user.username})`
      : `${user.first_name || "User"} (${user.user_id})`;
    const topic = await telegram.createForumTopic(groupId, name.slice(0, 120));
    const threadId = topic?.message_thread_id ?? topic?.messageThreadId;
    if (threadId === undefined || threadId === null) throw new Error("Telegram did not return a forum topic id");
    await telegram.sendMessage(groupId, formatTelegramUserInfo(user), { message_thread_id: threadId });
    user = await store.setTopicThreadId(userId, threadId);
    return user?.topic_thread_id ?? threadId;
  }

  async function forwardPrivateMessageToTopic(message, user) {
    let threadId = user.topic_thread_id;
    if (!threadId) threadId = await createTopicForUser(user.user_id);
    try {
      await telegram.copyMessage(groupId, message.chat.id, message.message_id, { message_thread_id: threadId });
    } catch (error) {
      if (!isThreadNotFoundTelegramError(error)) throw error;
      threadId = await createTopicForUser(user.user_id, { forceNew: true });
      await telegram.copyMessage(groupId, message.chat.id, message.message_id, { message_thread_id: threadId });
    }
  }

  async function ensurePrivateState(from) {
    const user = await store.upsertTelegramUser(from);
    if (Number(user?.is_blacklisted)) return { user, status: "blacklisted" };
    if (Number(user?.is_verified)) return { user, status: "verified" };
    let session = typeof store.getLatestPendingSessionForUser === "function"
      ? await store.getLatestPendingSessionForUser(user.user_id)
      : null;
    if (session && ((session.status && session.status !== "pending") || isExpiredIso(session.expires_at))) session = null;
    if (!session) session = await store.createVerificationSession(user.user_id, runtime.verificationTtlMinutes);
    const verificationUrl = `${runtime.appBaseUrl}/miniapp?startapp=${encodeURIComponent(session.session_id)}`;
    return { user, status: "pending", verificationUrl };
  }

  async function sendVerificationPrompt(user, verificationUrl) {
    if (user?.verification_prompt_chat_id !== null && user?.verification_prompt_chat_id !== undefined
      && user?.verification_prompt_message_id !== null && user?.verification_prompt_message_id !== undefined) {
      await safeDelete(user.verification_prompt_chat_id, user.verification_prompt_message_id);
    }
    const sent = await telegram.sendMessage(user.user_id, [
      "请先完成验证后再开始聊天。",
      "验证通过前，你发送的消息不会被转发。"
    ].join("\n"), { reply_markup: verificationPromptKeyboard(verificationUrl) });
    if (sent?.message_id !== undefined && typeof store.setVerificationPrompt === "function") {
      await store.setVerificationPrompt(user.user_id, sent.chat?.id ?? user.user_id, sent.message_id);
    }
  }

  async function handlePrivateMessage(message) {
    if (!message?.from || message.chat?.type !== "private") return;
    const text = String(message.text || "").trim();
    const isStart = /^\/start(?:@[^\s]+)?(?:\s|$)/i.test(text);
    if (!isStart && !isForwardableTelegramMessage(message)) return;
    const result = await ensurePrivateState(message.from);
    if (result.status === "blacklisted") {
      await telegram.sendMessage(message.chat.id, "你已被加入黑名单，消息不会被转发。");
      return;
    }
    if (result.status === "pending") {
      await sendVerificationPrompt(result.user, result.verificationUrl);
      return;
    }
    if (isStart) {
      await telegram.sendMessage(message.chat.id, "已通过验证，直接发送消息即可。");
      return;
    }
    await forwardPrivateMessageToTopic(message, result.user);
  }

  async function sendAdminReply(text, threadId, options = {}) {
    return telegram.sendMessage(groupId, text, {
      message_thread_id: threadId,
      ...options
    });
  }

  async function handleAdminCommand(message) {
    if (!sameId(message?.chat?.id, groupId) || message?.message_thread_id === undefined) return false;
    if (!/^\/admin(?:@[^\s]+)?(?:\s|$)/i.test(String(message.text || ""))) return false;
    if (!(await isGroupAdmin(message.from?.id))) {
      await sendAdminReply("你没有管理员权限。", message.message_thread_id);
      return true;
    }
    const user = await getUserForTopic(message.message_thread_id);
    if (!user) {
      await sendAdminReply("当前话题没有绑定用户。", message.message_thread_id);
      return true;
    }
    await sendAdminReply(buildTopicAdminText(user), message.message_thread_id, {
      reply_markup: topicAdminKeyboardForUser(user)
    });
    return true;
  }

  async function handlePendingAdminInput(message) {
    const threadId = message?.message_thread_id;
    if (!sameId(message?.chat?.id, groupId) || threadId === undefined || !message?.from) return false;
    if (message.from.is_bot) return false;
    let pending;
    const canConsumeAtomically = typeof store.consumePendingAdminAction === "function";
    if (canConsumeAtomically) {
      if (!(await isGroupAdmin(message.from.id))) return true;
      pending = await store.consumePendingAdminAction(threadId, message.from.id, "markfp");
      // Another webhook retry may have claimed and removed this action first;
      // consumePendingAdminAction reports a non-null sentinel for that case.
      if (!pending) return false;
      if (pending.consumed === false) return true;
    } else {
      pending = typeof store.getPendingAdminAction === "function"
        ? await store.getPendingAdminAction(threadId, message.from.id)
        : null;
    }
    const action = pending?.action;
    const actionType = typeof action === "string" ? action : action?.type ?? action?.action;
    if (!pending || actionType !== "markfp") return false;
    if (!canConsumeAtomically) {
      if (!(await isGroupAdmin(message.from.id))) return true;
      if (typeof store.deletePendingAdminAction === "function") await store.deletePendingAdminAction(threadId, message.from.id);
    }
    const parsed = parseFingerprintMarkInput(message.text);
    if (!parsed) {
      await sendAdminReply("标记失败，请使用 `标签|备注` 格式重新操作。", threadId, { parse_mode: "Markdown" });
      return true;
    }
    const topicUser = await getUserForTopic(threadId);
    if (!topicUser?.latest_fingerprint_meta?.id || (pending.user_id !== null && pending.user_id !== undefined
      && !sameId(pending.user_id, topicUser.user_id))) {
      await sendAdminReply("当前用户没有可标记的指纹。", threadId);
      return true;
    }
    const isBlocked = Boolean(typeof action === "object" && action.isBlocked);
    await store.createFingerprintLabel({
      labelName: parsed.label,
      note: parsed.note,
      fingerprintMeta: topicUser.latest_fingerprint_meta,
      sourceUserId: topicUser.user_id,
      createdByUserId: message.from.id,
      isBlocked
    });
    if (isBlocked && typeof store.setFingerprintLabelBlockedByName === "function") {
      await store.setFingerprintLabelBlockedByName(parsed.label, true);
    }
    await sendAdminReply([
      isBlocked ? "屏蔽指纹标签已保存" : "指纹标记已保存",
      `标签：${parsed.label}`,
      `指纹：${topicUser.latest_fingerprint_meta.id}`,
      `屏蔽：${isBlocked ? "是" : "否"}`,
      `备注：${parsed.note || "无"}`
    ].join("\n"), threadId);
    return true;
  }

  async function callbackContext(callback, userId = undefined) {
    const message = callback?.message;
    const threadId = message?.message_thread_id;
    if (!sameId(message?.chat?.id, groupId) || threadId === undefined) {
      await answerCallback(callback, "只能在群话题中使用");
      return null;
    }
    if (!(await isGroupAdmin(callback.from?.id))) {
      await answerCallback(callback, "无权限");
      return null;
    }
    const topicUser = await getUserForTopic(threadId);
    if (userId !== undefined && (!topicUser || !sameId(topicUser.user_id, userId))) {
      await answerCallback(callback, "话题用户不匹配");
      return null;
    }
    return { message, threadId, topicUser };
  }

  async function editCallbackMessage(message, text, replyMarkup) {
    if (typeof telegram.editMessageText !== "function") return;
    await telegram.editMessageText(groupId, message.message_id, text, { reply_markup: replyMarkup });
  }

  async function renderUserLabels(callback, topicUser, page) {
    const pageData = await store.getFingerprintLabelsPageByUserId(topicUser.user_id, page, 7);
    await editCallbackMessage(callback.message, fingerprintLabelsText(topicUser, pageData), fingerprintLabelsKeyboard(topicUser.user_id, pageData));
  }

  async function renderLabelNames(callback, page, userId, blockMode = false) {
    const pageData = await store.getDistinctFingerprintLabelNamesPage(page, 7);
    const prefix = blockMode ? ["选择要屏蔽的标签", "点击标签可切换屏蔽/取消屏蔽。", ""].join("\n") : "";
    await editCallbackMessage(callback.message, `${prefix}${prefix ? "\n" : ""}${fingerprintLabelNamesText(pageData)}`,
      fingerprintLabelNamesKeyboard(pageData, userId, { blockMode }));
  }

  async function handleCallback(callback) {
    const data = String(callback?.data || "");
    let match = /^topicadmin:(approve|cancel|ban|unban|username|markfp):(\d+)$/.exec(data);
    if (match) {
      const [, action, userIdRaw] = match;
      const userId = Number(userIdRaw);
      const context = await callbackContext(callback, userId);
      if (!context) return;
      const { message, threadId, topicUser } = context;
      if (action === "username") {
        await answerCallback(callback, `用户名：${topicUser.username ? `@${topicUser.username}` : "无"}`, { show_alert: true });
        return;
      }
      if (action === "approve") {
        await store.approveUser(userId);
        await telegram.sendMessage(userId, "管理员已为你通过验证。你现在发送的消息会转发到原话题。");
        await answerCallback(callback, "已通过验证");
      } else if (action === "cancel") {
        await store.cancelVerification(userId);
        await telegram.sendMessage(userId, "管理员已取消你的验证状态。重新完成验证前，你发送的消息不会被转发。");
        await answerCallback(callback, "已取消验证");
      } else if (action === "ban") {
        await store.blacklistUserDirect(userId);
        await telegram.sendMessage(userId, "管理员已将你加入黑名单，后续消息不会被转发。");
        await answerCallback(callback, "已拉黑");
      } else if (action === "unban") {
        await store.clearBlacklist(userId);
        await telegram.sendMessage(userId, "管理员已取消你的拉黑状态。");
        await answerCallback(callback, "已取消拉黑");
      } else if (action === "markfp") {
        if (!topicUser.latest_fingerprint_meta?.id) {
          await answerCallback(callback, "当前用户还没有可标记的指纹", { show_alert: true });
          return;
        }
        await store.upsertPendingAdminAction({
          threadId,
          adminId: callback.from.id,
          userId,
          action: { type: "markfp", isBlocked: false },
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        });
        await answerCallback(callback, "请发送：标签|备注");
        await safeDelete(groupId, message.message_id);
        await sendAdminReply("请在当前话题发送 `标签|备注` 来标记该用户当前指纹。备注可留空。", threadId, { parse_mode: "Markdown" });
        return;
      }
      await safeDelete(groupId, message.message_id);
      return;
    }

    match = /^topicadmin:labels:(\d+):(\d+)$/.exec(data);
    if (match) {
      const context = await callbackContext(callback, Number(match[1]));
      if (!context) return;
      await renderUserLabels(callback, context.topicUser, Number(match[2]));
      await answerCallback(callback);
      return;
    }
    match = /^topicadmin:dellabel:(\d+):(\d+):(\d+)$/.exec(data);
    if (match) {
      const context = await callbackContext(callback, Number(match[1]));
      if (!context) return;
      const label = await store.getFingerprintLabelById(Number(match[2]));
      const sourceUserId = label?.source_user_id ?? label?.sourceUserId;
      if (!label) {
        await answerCallback(callback, "标签不存在", { show_alert: true });
        return;
      }
      if (!sameId(sourceUserId, context.topicUser.user_id)) {
        await answerCallback(callback, "话题用户不匹配", { show_alert: true });
        return;
      }
      await store.deleteFingerprintLabelById(Number(match[2]));
      await renderUserLabels(callback, context.topicUser, Number(match[3]));
      await answerCallback(callback, "已删除标签");
      return;
    }
    match = /^topicadmin:closelabels:(\d+)$/.exec(data);
    if (match) {
      const context = await callbackContext(callback, Number(match[1]));
      if (!context) return;
      await safeDelete(groupId, callback.message.message_id);
      await answerCallback(callback);
      return;
    }
    match = /^topicadmin:labelnames:(\d+):(\d+)$/.exec(data);
    if (match) {
      const context = await callbackContext(callback, Number(match[2]));
      if (!context) return;
      await renderLabelNames(callback, Number(match[1]), Number(match[2]), false);
      await answerCallback(callback);
      return;
    }
    match = /^topicadmin:blocklabels:(\d+):(\d+)$/.exec(data);
    if (match) {
      const context = await callbackContext(callback, Number(match[2]));
      if (!context) return;
      await renderLabelNames(callback, Number(match[1]), Number(match[2]), true);
      await answerCallback(callback);
      return;
    }
    match = /^tld:(\d+):(\d+):(\d+)$/.exec(data);
    if (match) {
      const context = await callbackContext(callback, Number(match[2]));
      if (!context) return;
      const label = await store.getFingerprintLabelById(Number(match[3]));
      if (!label) {
        await answerCallback(callback, "标签不存在", { show_alert: true });
        return;
      }
      const items = uniqueFingerprintRows(await store.getFingerprintLabelsByName(label.label_name));
      const blocked = items.some((item) => item.is_blocked);
      await editCallbackMessage(callback.message, fingerprintLabelDetailText(label.label_name, items), {
        inline_keyboard: [
          [{ text: blocked ? "取消屏蔽标签" : "屏蔽标签", callback_data: `tlb:${blocked ? "u" : "b"}:${match[1]}:${match[2]}:${label.id}` }],
          [{ text: "返回标签名称", callback_data: `topicadmin:labelnames:${match[1]}:${match[2]}` }],
          [{ text: "关闭", callback_data: `topicadmin:closelabels:${match[2]}` }]
        ]
      });
      await answerCallback(callback);
      return;
    }
    match = /^tlb:([bu]):(\d+):(\d+):(\d+)$/.exec(data);
    if (match) {
      const context = await callbackContext(callback, Number(match[3]));
      if (!context) return;
      const label = await store.getFingerprintLabelById(Number(match[4]));
      if (!label) {
        await answerCallback(callback, "标签不存在", { show_alert: true });
        return;
      }
      const blocked = match[1] === "b";
      await store.setFingerprintLabelBlockedByName(label.label_name, blocked);
      const items = uniqueFingerprintRows(await store.getFingerprintLabelsByName(label.label_name));
      await editCallbackMessage(callback.message, fingerprintLabelDetailText(label.label_name, items), {
        inline_keyboard: [
          [{ text: blocked ? "取消屏蔽标签" : "屏蔽标签", callback_data: `tlb:${blocked ? "u" : "b"}:${match[2]}:${match[3]}:${label.id}` }],
          [{ text: "返回标签名称", callback_data: `topicadmin:labelnames:${match[2]}:${match[3]}` }],
          [{ text: "关闭", callback_data: `topicadmin:closelabels:${match[3]}` }]
        ]
      });
      await answerCallback(callback, blocked ? "已屏蔽标签" : "已取消屏蔽标签");
      return;
    }
    match = /^tbl:([bu]):(\d+):(\d+):(\d+)$/.exec(data);
    if (match) {
      const context = await callbackContext(callback, Number(match[3]));
      if (!context) return;
      const label = await store.getFingerprintLabelById(Number(match[4]));
      if (!label) {
        await answerCallback(callback, "标签不存在", { show_alert: true });
        return;
      }
      const blocked = match[1] === "b";
      await store.setFingerprintLabelBlockedByName(label.label_name, blocked);
      await renderLabelNames(callback, Number(match[2]), Number(match[3]), true);
      await answerCallback(callback, blocked ? "已屏蔽标签" : "已取消屏蔽标签");
    }
  }

  if (update?.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
  const message = update?.message;
  if (!message) return;
  if (message.chat?.type === "private") {
    await handlePrivateMessage(message);
    return;
  }
  if (!sameId(message.chat?.id, groupId)) return;
  if (await handleAdminCommand(message)) return;
  if (await handlePendingAdminInput(message)) return;
  if (!message.message_thread_id || !isForwardableTelegramMessage(message) || message.from?.is_bot) return;
  const user = await getUserForTopic(message.message_thread_id);
  if (!user || Number(user.is_blacklisted) || Number(user.is_verified) !== 1) return;
  await telegram.copyMessage(user.user_id, groupId, message.message_id);
}

/**
 * Claim Telegram's update_id before running side effects.  Completed updates
 * are acknowledged as duplicates, while failed updates release their lease
 * so Telegram retries can safely run again.
 */
export async function processTelegramUpdate(update, options = {}) {
  const { store } = options;
  if (!store || !options.telegram) throw new TypeError("store and telegram are required");
  const updateId = update?.update_id;
  const trackable = updateId !== null && updateId !== undefined
    && String(updateId).trim() !== ""
    && typeof store.claimTelegramUpdate === "function";
  const botToken = String(configValue(
    options.config || {},
    ["TG_BOT_TOKEN", "tgBotToken", "botToken", "token"],
    ""
  ));
  const botNamespace = trackable ? await sha256Hex(botToken) : "";
  let claim = null;
  if (trackable) {
    claim = await store.claimTelegramUpdate(updateId, 300_000, botNamespace);
    if (!claim?.claimed) {
      return {
        skipped: true,
        duplicate: Boolean(claim?.completed),
        update_id: updateId
      };
    }
  }

  try {
    const result = await processTelegramUpdateCore(update, options);
    if (claim?.claimed && typeof store.completeTelegramUpdate === "function") {
      await store.completeTelegramUpdate(
        updateId,
        claim.leaseToken || claim.lease_token,
        botNamespace
      );
    }
    return result;
  } catch (error) {
    if (claim?.claimed && typeof store.releaseTelegramUpdate === "function") {
      try {
        await store.releaseTelegramUpdate(
          updateId,
          claim.leaseToken || claim.lease_token,
          botNamespace
        );
      } catch {}
    }
    throw error;
  }
}

const WEBHOOK_PATH = "/telegram/webhook";
const WEBHOOK_DIGEST_KEY = "webhook_digest";

// D1 is the source of truth for this value.  The weak cache is only a small
// optimization for bindings that do not return a value from an upsert (and it
// also avoids duplicate registration during a burst of health checks in one
// isolate).  A changed persisted value always wins over this cache.
const webhookDigestCache = new WeakMap();

function jsonResponse(payload, status = 200, headers = {}) {
  const responseHeaders = new Headers({ "Content-Type": "application/json; charset=utf-8", ...headers });
  return new Response(payload === null ? null : JSON.stringify(payload), {
    status,
    headers: responseHeaders
  });
}

function withVerificationCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Bot-Api-Secret-Token");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function telegramOptions(payload, excluded) {
  const result = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (!excluded.includes(key)) result[key] = value;
  }
  return result;
}

/**
 * Adapt the deterministic fake Telegram client used by tests (or another
 * injected client) to the fetch transport expected by createTelegramClient.
 * Production deployments simply fall through to global fetch.
 */
function telegramFetchForEnv(env = {}) {
  const explicit = configValue(env, ["TELEGRAM_FETCH", "telegramFetch"], undefined);
  if (typeof explicit === "function") return explicit;

  const injected = env?.telegram;
  if (injected && typeof injected === "object") {
    return async (url, init = {}) => {
      const method = String(url).split("/").pop() || "";
      let payload = {};
      try {
        payload = init.body ? JSON.parse(init.body) : {};
      } catch {
        payload = {};
      }

      try {
        let result;
        const convenience = injected[method];
        if (typeof convenience === "function") {
          switch (method) {
            case "getMe":
              result = await convenience();
              break;
            case "getChat":
              result = await convenience(payload.chat_id);
              break;
            case "getChatMember":
              result = await convenience(payload.chat_id, payload.user_id);
              break;
            case "setWebhook":
              result = await convenience(payload.url, payload.secret_token);
              break;
            case "sendMessage":
              result = await convenience(payload.chat_id, payload.text,
                telegramOptions(payload, ["chat_id", "text"]));
              break;
            case "copyMessage":
              result = await convenience(payload.chat_id, payload.from_chat_id, payload.message_id,
                telegramOptions(payload, ["chat_id", "from_chat_id", "message_id"]));
              break;
            case "createForumTopic":
              result = await convenience(payload.chat_id, payload.name);
              break;
            case "answerCallbackQuery":
              result = await convenience(payload.callback_query_id, payload.text,
                telegramOptions(payload, ["callback_query_id", "text"]));
              break;
            case "editMessageText":
              result = await convenience(payload.chat_id, payload.message_id, payload.text,
                telegramOptions(payload, ["chat_id", "message_id", "text"]));
              break;
            case "deleteMessage":
              result = await convenience(payload.chat_id, payload.message_id);
              break;
            case "deleteForumTopic":
              result = await convenience(payload.chat_id, payload.message_thread_id);
              break;
            default:
              result = await convenience(payload);
              break;
          }
        } else if (typeof injected.call === "function") {
          result = await injected.call(method, payload);
        } else {
          throw new Error("Injected Telegram client has no callable method");
        }
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          ok: false,
          error_code: Number(error?.code || error?.status || 500),
          description: String(error?.description || error?.message || "Telegram request failed")
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    };
  }

  const fallback = configValue(env, ["fetchImpl"], undefined);
  return typeof fallback === "function" ? fallback : globalThis.fetch;
}

function createRouterTelegram(env = {}) {
  return createTelegramClient({
    token: configValue(env, ["TG_BOT_TOKEN", "tgBotToken", "botToken", "token"], ""),
    fetchImpl: telegramFetchForEnv(env)
  });
}

function requestOrigin(request) {
  try {
    return new URL(request?.url || "https://sentinelrelay.invalid/").origin;
  } catch {
    return "https://sentinelrelay.invalid";
  }
}

/**
 * Register Telegram's webhook after D1 has been initialized.  The digest is
 * persisted so every stateless Worker instance can skip an unchanged
 * registration; the weak cache only covers non-persistent test bindings.
 */
export async function ensureWebhook(env = {}, request, store, telegram) {
  if (!store || typeof store.getRuntimeSetting !== "function" || typeof store.setRuntimeSetting !== "function") {
    throw new TypeError("store runtime settings are required");
  }
  if (!telegram || typeof telegram.setWebhook !== "function") {
    throw new TypeError("Telegram webhook client is required");
  }

  const configuredBase = normalizeString(configValue(env, ["APP_BASE_URL", "appBaseUrl", "app_base_url"], ""));
  const baseUrl = (configuredBase || requestOrigin(request)).replace(/\/+$/, "");
  const secret = String(configValue(env, ["TG_WEBHOOK_SECRET", "tgWebhookSecret", "webhookSecret"], ""));
  // Include only a one-way token digest so rotating Bot credentials forces a
  // fresh Telegram registration without ever persisting the raw token in D1.
  const botToken = String(configValue(env, ["TG_BOT_TOKEN", "tgBotToken", "botToken", "token"], ""));
  const botTokenDigest = await sha256Hex(botToken);
  const digest = await sha256Hex([baseUrl, WEBHOOK_PATH, secret, botTokenDigest].join("\n"));
  const persisted = await store.getRuntimeSetting(WEBHOOK_DIGEST_KEY);
  if (persisted === digest) {
    if (env?.DB && typeof env.DB === "object") webhookDigestCache.set(env.DB, digest);
    return { registered: false, skipped: true };
  }
  const persistedMissing = persisted === null || persisted === undefined || normalizeString(persisted) === "";
  if (persistedMissing && env?.DB && typeof env.DB === "object" && webhookDigestCache.get(env.DB) === digest) {
    return { registered: false, skipped: true };
  }

  await telegram.setWebhook(`${baseUrl}${WEBHOOK_PATH}`, secret);
  await store.setRuntimeSetting(WEBHOOK_DIGEST_KEY, digest);
  if (env?.DB && typeof env.DB === "object") webhookDigestCache.set(env.DB, digest);
  return { registered: true, skipped: false };
}

function verificationApiPath(pathname) {
  return pathname === "/api/verify" || pathname.startsWith("/api/verify/");
}

function decodePathSegment(value) {
  try { return decodeURIComponent(value); } catch { return ""; }
}

/** Module Worker entry point for health, Telegram, and verification routes. */
export async function handleRequest(request, env = {}, ctx = {}) {
  let url;
  try {
    url = new URL(request?.url || "https://sentinelrelay.invalid/");
  } catch {
    return jsonResponse({ ok: false, error: "Invalid request URL" }, 400);
  }
  const method = String(request?.method || "GET").toUpperCase();
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "/";
  const isVerificationApi = verificationApiPath(pathname);

  let store;
  try {
    store = createStore(env?.DB);
    // Schema initialization is deliberately awaited.  No handler below may
    // read or write D1 before this completes.
    await store.ensureSchema();
  } catch {
    const response = jsonResponse({ ok: false, error: "D1 初始化失败" }, 500);
    return isVerificationApi ? withVerificationCors(response) : response;
  }

  if (method === "OPTIONS" && isVerificationApi) {
    return withVerificationCors(new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*" }
    }));
  }

  let telegram;
  const getTelegram = () => {
    if (!telegram) telegram = createRouterTelegram(env);
    return telegram;
  };

  if (pathname === "/") {
    if (method !== "GET") return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
    return new Response("SentinelRelay Worker is running", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  if (pathname === "/health") {
    if (method !== "GET") return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
    try {
      const webhook = await ensureWebhook(env, request, store, getTelegram());
      return jsonResponse({ ok: true, schema: true, webhook });
    } catch {
      return jsonResponse({ ok: false, schema: true, error: "Webhook 注册失败" }, 502);
    }
  }

  if (pathname === WEBHOOK_PATH) {
    if (method !== "POST") return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
    const expectedSecret = String(configValue(env, ["TG_WEBHOOK_SECRET", "tgWebhookSecret", "webhookSecret"], ""));
    const receivedSecret = requestHeader(request, "x-telegram-bot-api-secret-token");
    if (!expectedSecret || receivedSecret !== expectedSecret) {
      // Check the secret before touching request.json(), so an attacker cannot
      // force parsing of arbitrary update bodies with an invalid credential.
      return jsonResponse({ ok: false, error: "Forbidden" }, 403);
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
    }
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      return jsonResponse({ ok: false, error: "Invalid update" }, 400);
    }
    try {
      await processTelegramUpdate(update, { config: env, store, telegram: getTelegram() });
      return jsonResponse({ ok: true });
    } catch {
      return jsonResponse({ ok: false, error: "Telegram update failed" }, 500);
    }
  }

  if (pathname === "/miniapp") {
    if (method !== "GET") return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
    const sessionId = normalizeString(url.searchParams.get("session")
      || url.searchParams.get("startapp")
      || url.searchParams.get("tgWebAppStartParam"));
    if (!sessionId) {
      const page = renderMiniAppVerificationPage({
        siteKey: configValue(env, ["TURNSTILE_SITE_KEY", "turnstileSiteKey", "siteKey"], ""),
        stunServerUrl: configValue(env, ["STUN_SERVER_URL", "stunServerUrl"], "stun:stun.miwifi.com:3478")
      });
      return new Response(page, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    try {
      const response = await handleVerificationRequest(request, sessionId, {
        miniApp: true,
        env,
        store,
        telegram: method === "POST" ? getTelegram() : undefined
      });
      return response;
    } catch {
      return resultResponse("验证服务异常", "验证服务暂时不可用，请稍后重试。", 500);
    }
  }

  const verifyMatch = /^\/verify\/([^/]+)$/.exec(pathname);
  if (verifyMatch) {
    if (method !== "GET") return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
    const sessionId = decodePathSegment(verifyMatch[1]);
    try {
      const response = await handleVerificationRequest(request, sessionId, {
        env,
        store,
        telegram: undefined
      });
      return response;
    } catch {
      return resultResponse("验证服务异常", "验证服务暂时不可用，请稍后重试。", 500);
    }
  }

  const apiVerifyMatch = /^\/api\/verify\/([^/]+)$/.exec(pathname);
  if (apiVerifyMatch || pathname === "/api/verify") {
    const sessionId = apiVerifyMatch ? decodePathSegment(apiVerifyMatch[1]) : "";
    if (method !== "POST") {
      const response = jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
      return withVerificationCors(response);
    }
    try {
      const response = await handleVerificationRequest(request, sessionId, {
        miniApp: !apiVerifyMatch,
        env,
        store,
        telegram: getTelegram()
      });
      return withVerificationCors(response);
    } catch {
      return withVerificationCors(resultResponse("验证服务异常", "验证服务暂时不可用，请稍后重试。", 500));
    }
  }

  const response = jsonResponse({ ok: false, error: "Not Found" }, 404);
  return isVerificationApi ? withVerificationCors(response) : response;
}

export default { fetch: handleRequest };
