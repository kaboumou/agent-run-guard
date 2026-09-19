/**
 * Agent Run Guard — core/config.js
 * Pure ESM, stdlib-only, no harness imports.
 *
 * Config sources (precedence, highest last): defaults < JSON file < env vars.
 * All env names keep the AGENT_RUN_GUARD_* prefix (v0.1 names preserved).
 */

export const DEFAULTS = Object.freeze({
  maxIdentical: 3,
  maxNearDuplicate: 3,
  maxCalls: 300,
  maxMinutes: 0, // 0 = off
  maxCost: 0, // USD, OpenCode only, 0 = off
  maxConsecutiveErrors: 5,
  mode: "deny", // deny | warn — applies to repeats, budgets, error-storm
  dangerousMode: "warn", // deny | warn
  secretMode: "warn", // deny | warn
  injectContext: true, // OpenCode: session.prompt corrective context on block
  abortMode: "cost-only", // never | cost-only | always (OpenCode hard limits; best-effort)
  logFile: null,
  nearNormalizeNumerics: false, // opt-in: mask read-style line/offset/limit numbers in near keys
});

const INT_KEYS = [
  "maxIdentical",
  "maxNearDuplicate",
  "maxCalls",
  "maxMinutes",
  "maxConsecutiveErrors",
];

function toNum(raw) {
  // Type coercion only (no defaults here — validateConfig owns semantics).
  // Empty string counts as unset; non-finite counts as invalid.
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function normMode(raw) {
  // Pass through a normalized token; validateConfig decides validity.
  if (raw === undefined || raw === null) return undefined;
  return String(raw).toLowerCase().trim();
}

function toBool(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).toLowerCase().trim();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

/** Read overrides from environment variables (raw; validated later). */
export function fromEnv(env = process.env) {
  const out = {};
  const num = (name, key) => {
    if (env[name] !== undefined) out[key] = toNum(env[name]);
  };
  num("AGENT_RUN_GUARD_MAX_IDENTICAL", "maxIdentical");
  num("AGENT_RUN_GUARD_MAX_NEAR", "maxNearDuplicate");
  num("AGENT_RUN_GUARD_MAX_CALLS", "maxCalls");
  num("AGENT_RUN_GUARD_MAX_MINUTES", "maxMinutes");
  num("AGENT_RUN_GUARD_MAX_COST", "maxCost");
  num("AGENT_RUN_GUARD_MAX_ERRORS", "maxConsecutiveErrors");
  if (env.AGENT_RUN_GUARD_MODE !== undefined)
    out.mode = normMode(env.AGENT_RUN_GUARD_MODE);
  if (env.AGENT_RUN_GUARD_DANGEROUS_MODE !== undefined)
    out.dangerousMode = normMode(env.AGENT_RUN_GUARD_DANGEROUS_MODE);
  if (env.AGENT_RUN_GUARD_SECRET_MODE !== undefined)
    out.secretMode = normMode(env.AGENT_RUN_GUARD_SECRET_MODE);
  if (env.AGENT_RUN_GUARD_LOG !== undefined)
    out.logFile = env.AGENT_RUN_GUARD_LOG || null;
  if (env.AGENT_RUN_GUARD_INJECT_CONTEXT !== undefined) {
    const b = toBool(env.AGENT_RUN_GUARD_INJECT_CONTEXT);
    if (b !== undefined) out.injectContext = b;
  }
  if (env.AGENT_RUN_GUARD_ABORT !== undefined) {
    const v = String(env.AGENT_RUN_GUARD_ABORT).toLowerCase().trim();
    if (v === "never" || v === "cost-only" || v === "always") out.abortMode = v;
    else if (v === "1" || v === "true" || v === "yes" || v === "on") out.abortMode = "always";
    else if (v === "0" || v === "false" || v === "no" || v === "off") out.abortMode = "never";
    else out.abortMode = v; // invalid token flows to the validator (warn + default)
  }
  if (env.AGENT_RUN_GUARD_NEAR_NUMERICS !== undefined) {
    const b = toBool(env.AGENT_RUN_GUARD_NEAR_NUMERICS);
    if (b !== undefined) out.nearNormalizeNumerics = b;
  }
  return out;
}

/** Normalize a parsed JSON config object (camelCase keys). Unknown keys ignored. */
export function fromObject(obj = {}) {
  const out = {};
  if (obj === null || typeof obj !== "object") return out;
  for (const k of INT_KEYS) {
    if (obj[k] !== undefined) out[k] = toNum(obj[k]);
  }
  if (obj.maxCost !== undefined) out.maxCost = toNum(obj.maxCost);
  if (obj.mode !== undefined) out.mode = normMode(obj.mode);
  if (obj.dangerousMode !== undefined)
    out.dangerousMode = normMode(obj.dangerousMode);
  if (obj.secretMode !== undefined)
    out.secretMode = normMode(obj.secretMode);
  if (obj.logFile !== undefined) out.logFile = obj.logFile || null;
  if (obj.injectContext !== undefined) {
    const b = toBool(obj.injectContext);
    if (b !== undefined) out.injectContext = b;
  }
  if (obj.abortMode !== undefined) {
    out.abortMode = String(obj.abortMode).toLowerCase().trim();
  }
  if (obj.nearNormalizeNumerics !== undefined) {
    const b = toBool(obj.nearNormalizeNumerics);
    if (b !== undefined) out.nearNormalizeNumerics = b;
  }
  return out;
}

/** Load a JSON config file. Returns {} when path is unset or unreadable. */
export async function fromFile(configPath) {
  if (!configPath) return {};
  try {
    const fs = await import("node:fs");
    const raw = fs.readFileSync(configPath, "utf8");
    return fromObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Resolve final config: defaults < file object < env. Raw values flow through;
 * use loadConfig() for the validated result. */
export function resolveConfig({ fileObj = {}, env = process.env, overrides = {} } = {}) {
  return {
    ...DEFAULTS,
    ...fromObject(fileObj),
    ...fromEnv(env),
    ...fromObject(overrides),
  };
}

const COUNT_KEYS = ["maxIdentical", "maxNearDuplicate", "maxCalls", "maxConsecutiveErrors"];

/**
 * Single validator used by the CLI and every adapter (R4).
 * Rules: counts >= 1; maxMinutes 0 = disabled else >= 1; maxCost 0 = disabled
 * else positive finite; modes from their allowlists. Invalid values fall back
 * to DEFAULTS with a warning string each.
 */
export function validateConfig(raw = {}) {
  const warnings = [];
  const cfg = { ...DEFAULTS };
  const src = raw && typeof raw === "object" ? raw : {};

  for (const k of COUNT_KEYS) {
    const v = src[k];
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || Math.floor(n) < 1) {
      warnings.push(`${k}=${JSON.stringify(v)} invalid, using default ${DEFAULTS[k]}`);
      continue;
    }
    cfg[k] = Math.floor(n);
  }

  if (src.maxMinutes !== undefined) {
    const n = Number(src.maxMinutes);
    if (!Number.isFinite(n) || n < 0) {
      warnings.push(`maxMinutes=${JSON.stringify(src.maxMinutes)} invalid, using default ${DEFAULTS.maxMinutes}`);
    } else if (n === 0) {
      cfg.maxMinutes = 0;
    } else if (Math.floor(n) < 1) {
      cfg.maxMinutes = 1;
    } else {
      cfg.maxMinutes = Math.floor(n);
    }
  }

  if (src.maxCost !== undefined) {
    const n = Number(src.maxCost);
    if (!Number.isFinite(n) || n < 0) {
      warnings.push(`maxCost=${JSON.stringify(src.maxCost)} invalid, using default ${DEFAULTS.maxCost}`);
    } else {
      cfg.maxCost = n;
    }
  }

  for (const k of ["mode", "dangerousMode", "secretMode"]) {
    if (src[k] === undefined) continue;
    const v = String(src[k]).toLowerCase().trim();
    if (v === "deny" || v === "warn") cfg[k] = v;
    else warnings.push(`${k}=${JSON.stringify(src[k])} invalid, using default ${DEFAULTS[k]}`);
  }

  if (src.abortMode !== undefined) {
    const v = String(src.abortMode).toLowerCase().trim();
    if (v === "never" || v === "cost-only" || v === "always") cfg.abortMode = v;
    else warnings.push(`abortMode=${JSON.stringify(src.abortMode)} invalid, using default ${DEFAULTS.abortMode}`);
  }

  if (src.injectContext !== undefined) {
    const b = toBool(src.injectContext);
    if (b === undefined) warnings.push(`injectContext invalid, using default ${DEFAULTS.injectContext}`);
    else cfg.injectContext = b;
  }

  if (src.nearNormalizeNumerics !== undefined) {
    const b = toBool(src.nearNormalizeNumerics);
    if (b === undefined) warnings.push(`nearNormalizeNumerics invalid, using default ${DEFAULTS.nearNormalizeNumerics}`);
    else cfg.nearNormalizeNumerics = b;
  }

  if (src.logFile !== undefined) cfg.logFile = src.logFile || null;

  return { config: cfg, warnings };
}

/** Resolve + validate in one step. The one entry point for CLI and adapters. */
export function loadConfig({ fileObj = {}, env = process.env, overrides = {} } = {}) {
  return validateConfig(resolveConfig({ fileObj, env, overrides }));
}
