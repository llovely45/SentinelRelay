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
  FOREIGN KEY(source_user_id) REFERENCES users(user_id),
  FOREIGN KEY(created_by_user_id) REFERENCES users(user_id)
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
    return first(`
      SELECT vs.*, u.username, u.first_name, u.last_name, u.language_code,
        u.is_verified, u.is_blacklisted, u.topic_thread_id,
        u.latest_fingerprint_id, u.latest_fingerprint_payload,
        u.verification_prompt_chat_id, u.verification_prompt_message_id
      FROM verification_sessions vs
      JOIN users u ON u.user_id = vs.user_id
      WHERE vs.session_id = ?
      LIMIT 1
    `, sessionId);
  }

  async function getLatestPendingSessionForUser(userId) {
    return first(`
      SELECT * FROM verification_sessions
      WHERE user_id = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `, userId);
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
    const session = await getSession(sessionId);
    if (!session || String(session.user_id) !== String(userId) || session.status !== "pending") return getUser(userId);
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`
        UPDATE users
        SET is_verified = 1, is_blacklisted = 0, topic_thread_id = ?,
          verification_prompt_chat_id = NULL, verification_prompt_message_id = NULL, updated_at = ?
        WHERE user_id = ?
      `).bind(threadId, now, userId),
      db.prepare(`
        UPDATE verification_sessions
        SET status = 'passed', consumed_at = ?
        WHERE session_id = ? AND user_id = ? AND status = 'pending'
      `).bind(now, sessionId, userId)
    ]);
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

// Task 2 deliberately keeps the production entrypoint inert; later tasks wire
// this fetch function to the Telegram/web verification router.
async function handleRequest() {
  return new Response("SentinelRelay Worker", { status: 200 });
}

export default { fetch: handleRequest };
