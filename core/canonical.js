/**
 * Agent Run Guard — core/canonical.js
 * Pure ESM, stdlib-only. Canonical hashing, near-duplicate normalization,
 * and redacted fingerprints (never log raw argument values).
 */

import { createHash } from "node:crypto";

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function canonical(value) {
  try {
    return JSON.stringify(sortKeys(value ?? {}));
  } catch {
    return String(value);
  }
}

export function sha256hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** Hash-shaped counter keys: "ex@<64hex>" (identical) / "nx@<64hex>" (near). */
export const HASH_KEY_RE = /^(ex|nx)@[0-9a-f]{64}$/;

/**
 * Deterministic hash of the exact key. Same (tool, args) always yields the
 * same key across processes; the raw canonical string is never persisted.
 */
export function exactHash(tool, args) {
  return "ex@" + sha256hex(String(tool) + "|" + canonical(args));
}

/** Deterministic hash of the normalized (near-duplicate) key. */
export function nearHash(tool, args, opts = {}) {
  return "nx@" + sha256hex(nearKey(tool, args, opts));
}

export function sha12(text) {
  try {
    return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 12);
  } catch {
    // Extremely defensive fallback (non-crypto FNV-1a hex).
    let h = 0x811c9dc5;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0") + "0000";
  }
}

/**
 * Normalize a string for near-duplicate detection:
 * - collapse whitespace
 * - strip ISO timestamps, UUIDs, long hex ids, PIDs, temp paths, line numbers
 */
export function normalizeText(raw) {
  let s = String(raw ?? "");
  // Temp paths first (before whitespace collapse so separators survive).
  s = s.replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, (m) =>
    /temp|tmp|cache/i.test(m) ? "<TMPPATH>" : m
  );
  s = s.replace(/\/(?:tmp|var\/folders|private\/tmp)[^\s"'`]* /g, "<TMPPATH> ");
  s = s.replace(/\/(?:tmp|var\/folders|private\/tmp)[^\s"'`]*/g, "<TMPPATH>");
  // ISO timestamps: 2026-09-19T12:34:56(.789)(Z/+hh:mm) and "2026-09-19 12:34:56".
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, "<TS>");
  // UUIDs.
  s = s.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<ID>");
  // Long hex ids (commit SHAs, run ids): 7..64 hex chars as a full token.
  s = s.replace(/\b[0-9a-fA-F]{7,64}\b/g, (m) =>
    /[0-9]/.test(m) && /[a-fA-F]/.test(m) ? "<ID>" : m
  );
  // PIDs: "pid 12345", "pid=12345", "pid:12345".
  s = s.replace(/\bpid[:= ]+\d+\b/gi, "pid <PID>");
  // Line numbers: ":123:" suffixes and "line 123".
  s = s.replace(/:(\d{1,6}):/g, ":<LN>:");
  s = s.replace(/\bline \d{1,6}\b/gi, "line <LN>");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Normalize an args object (deep, string-aware) before canonical hashing. */
export function normalizeArgs(args) {
  if (typeof args === "string") return normalizeText(args);
  if (Array.isArray(args)) return args.map(normalizeArgs);
  if (args && typeof args === "object") {
    const out = {};
    for (const key of Object.keys(args)) out[key] = normalizeArgs(args[key]);
    return out;
  }
  return args;
}

/**
 * Read-style numeric fields masked ONLY under the opt-in profile
 * (config nearNormalizeNumerics, env AGENT_RUN_GUARD_NEAR_NUMERICS).
 * Default OFF: legitimate pagination across line ranges must NOT collapse.
 */
export const READ_NUMERIC_FIELDS = Object.freeze([
  "start_line",
  "end_line",
  "offset",
  "limit",
  "line",
  "lines",
]);

const READ_TOOL_RE = /^(read|cat|show|view)$/i;

/** Tool-aware normalization: masks read-style numerics when profile is on. */
export function normalizeArgsForTool(tool, args, opts = {}) {
  const normalized = normalizeArgs(args);
  if (!opts.nearNormalizeNumerics) return normalized;
  if (!READ_TOOL_RE.test(String(tool ?? ""))) return normalized;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return normalized;
  const out = { ...normalized };
  for (const f of READ_NUMERIC_FIELDS) {
    if (typeof out[f] === "number" || (typeof out[f] === "string" && /^\d+$/.test(out[f]))) {
      out[f] = "<N>";
    }
  }
  return out;
}

/** Exact key: tool + canonical(args). */
export function exactKey(tool, args) {
  return String(tool) + "|" + canonical(args);
}

/** Near-duplicate key: tool + canonical(normalized args). */
export function nearKey(tool, args, opts = {}) {
  return String(tool) + "|~" + canonical(sortKeys(normalizeArgsForTool(tool, args ?? {}, opts)));
}

/**
 * Redacted fingerprint for logs: { hash, len }. Raw values never logged.
 * Hash covers tool + canonical args; len is the canonical string length.
 */
export function fingerprint(tool, args) {
  const canon = canonical(args);
  return { hash: sha12(String(tool) + "|" + canon), len: canon.length };
}
