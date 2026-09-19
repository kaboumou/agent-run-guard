/**
 * Agent Run Guard — core/state.js
 * Pure ESM, stdlib-only (node:fs / node:path / node:crypto only at the edges).
 * Session-keyed JSON state with atomic write (tmp + rename), safe for
 * cross-process CLI use on Windows and POSIX. No bashisms.
 */

import { sha256hex, HASH_KEY_RE } from "./canonical.js";

/**
 * R8 state identity: filenames are sha256(harness + session-or-cwd) hex —
 * no sanitized session ids on disk, no readable names. The cwd fallback
 * keeps working (sessionId empty → "cwd:<dir>").
 */
export function sessionFileName({ harness, sessionId, cwd } = {}) {
  const h = String(harness || "generic").toLowerCase();
  const sid = sessionId && String(sessionId).trim() ? String(sessionId).trim() : "";
  const base = sid || "cwd:" + (String(cwd || "default").trim() || "default");
  try {
    return sha256hex(h + ":" + base) + ".json";
  } catch {
    return "fallback.json";
  }
}

export function stateFilePath(stateDir, fileName) {
  return stateDir + "/" + fileName;
}

/** Inactivity expiry for session state (R8): 24 h default. */
export const STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** True when the snapshot is missing activity or older than ttlMs. */
export function isExpired(snapshot, now = Date.now(), ttlMs = STATE_TTL_MS) {
  const last = Number(snapshot?.lastSeen ?? snapshot?.startedAt ?? 0);
  if (!Number.isFinite(last) || last <= 0) return true;
  return now - last > ttlMs;
}

/** Serializable snapshot shape for the engine counters (v2: hash keys). */
export function blankSnapshot() {
  const now = Date.now();
  return {
    v: 2,
    totalCalls: 0,
    identicalCounts: {},
    nearCounts: {},
    consecutiveErrors: 0,
    stormActive: false,
    spentCost: 0,
    startedAt: now,
    lastSeen: now,
    blockedCount: 0,
    warnedCount: 0,
    knownFailures: [],
    seenResultIds: [],
  };
}

/** Keep only hash-shaped counter keys; discard legacy v1 raw-arg keys. */
function filterHashKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = Math.floor(Number(v));
    if (HASH_KEY_RE.test(k) && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

function normalizeSnapshot(raw) {
  const base = blankSnapshot();
  if (!raw || typeof raw !== "object") return base;
  const out = { ...base };
  for (const k of ["totalCalls", "consecutiveErrors", "blockedCount", "warnedCount"]) {
    const n = Number(raw[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
  }
  if (Number.isFinite(Number(raw.spentCost)) && Number(raw.spentCost) >= 0)
    out.spentCost = Number(raw.spentCost);
  if (Number.isFinite(Number(raw.startedAt)) && Number(raw.startedAt) > 0)
    out.startedAt = Number(raw.startedAt);
  if (Number.isFinite(Number(raw.lastSeen)) && Number(raw.lastSeen) > 0)
    out.lastSeen = Number(raw.lastSeen);
  else out.lastSeen = out.startedAt;
  if (raw.identicalCounts && typeof raw.identicalCounts === "object")
    out.identicalCounts = filterHashKeys(raw.identicalCounts);
  if (raw.nearCounts && typeof raw.nearCounts === "object")
    out.nearCounts = filterHashKeys(raw.nearCounts);
  if (raw.stormActive === true) out.stormActive = true;
  if (Array.isArray(raw.knownFailures))
    out.knownFailures = raw.knownFailures.filter((x) => typeof x === "string").slice(0, 20);
  if (Array.isArray(raw.seenResultIds))
    out.seenResultIds = raw.seenResultIds
      .filter((x) => typeof x === "string" && x.length >= 12)
      .slice(-200);
  return out;
}

/** Load a snapshot; returns a blank snapshot when missing/unreadable. */
export async function loadSnapshot(stateFile) {
  try {
    const fs = await import("node:fs");
    const raw = fs.readFileSync(stateFile, "utf8");
    return normalizeSnapshot(JSON.parse(raw));
  } catch {
    return blankSnapshot();
  }
}

/** Atomic write: tmp file + rename. Creates the directory if needed. */
export async function saveSnapshotAtomic(stateFile, snapshot) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = stateFile + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
  fs.renameSync(tmp, stateFile);
}

/**
 * Best-effort atomic save with bounded retries. Transient filesystem states
 * (Windows EPERM/EBUSY from scanners, brief locks) must not silently drop a
 * counted event: retry up to 3 times ~25 ms apart, then throw so the caller
 * can fail open loudly rather than pretend the event was recorded.
 */
export async function saveSnapshotBestEffort(stateFile, snapshot, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      await saveSnapshotAtomic(stateFile, snapshot);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastErr;
}
