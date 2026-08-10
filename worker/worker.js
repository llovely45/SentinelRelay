/*
 * SentinelRelay Cloudflare Worker runtime.
 *
 * This file intentionally has no npm dependencies.  Task 2 owns the durable
 * D1 repository and the pure fingerprint primitives; later tasks add Telegram,
 * verification pages, and routing around these exports.
 */

const textEncoder = new TextEncoder();

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
  return Number.isFinite(timestamp) && timestamp <= now;
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

  async function markVerified(userId, threadId, sessionId) {
    const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare(`
        UPDATE verification_sessions
        SET status = 'passed', consumed_at = ?
        WHERE session_id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM users WHERE user_id = ? AND is_verified = 0
          )
      `).bind(now, sessionId, userId, now, userId),
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
    return getUser(userId);
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
    getRuntimeSetting,
    setRuntimeSetting
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

    const httpOk = response.ok === undefined
      ? Number(response.status) >= 200 && Number(response.status) < 300
      : response.ok;
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
    deleteMessage: (chatId, messageId) => call("deleteMessage", { chat_id: chatId, message_id: messageId })
  };
}

function configValue(config, names, fallback = undefined) {
  for (const name of names) {
    if (config && config[name] !== undefined && config[name] !== null) return config[name];
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
export async function processTelegramUpdate(update, { config = {}, store, telegram } = {}) {
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
    const pending = typeof store.getPendingAdminAction === "function"
      ? await store.getPendingAdminAction(threadId, message.from.id)
      : null;
    const action = pending?.action;
    const actionType = typeof action === "string" ? action : action?.type ?? action?.action;
    if (!pending || actionType !== "markfp") return false;
    if (!(await isGroupAdmin(message.from.id))) return true;
    if (typeof store.deletePendingAdminAction === "function") await store.deletePendingAdminAction(threadId, message.from.id);
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
  if (!user || Number(user.is_blacklisted)) return;
  await telegram.copyMessage(user.user_id, groupId, message.message_id);
}

// Task 2 deliberately keeps the production entrypoint inert; later tasks wire
// this fetch function to the Telegram/web verification router.
async function handleRequest() {
  return new Response("SentinelRelay Worker", { status: 200 });
}

export default { fetch: handleRequest };
