/** Agent Run Guard — core/index.js (re-exports). */
export { DEFAULTS, fromEnv, fromObject, fromFile, resolveConfig, validateConfig, loadConfig } from "./config.js";
export {
  sortKeys,
  canonical,
  sha12,
  sha256hex,
  HASH_KEY_RE,
  exactHash,
  nearHash,
  normalizeText,
  normalizeArgs,
  normalizeArgsForTool,
  READ_NUMERIC_FIELDS,
  exactKey,
  nearKey,
  fingerprint,
} from "./canonical.js";
export {
  DANGEROUS_PATTERNS,
  SECRET_PATTERNS,
  commandText,
  allText,
  matchDangerous,
  matchSecrets,
  matchSecretIds,
  matchShellWriteSecrets,
  shellWriteForms,
  looksLikeWrite,
} from "./patterns.js";
export {
  sessionFileName,
  stateFilePath,
  blankSnapshot,
  isExpired,
  STATE_TTL_MS,
  loadSnapshot,
  saveSnapshotAtomic,
  saveSnapshotBestEffort,
} from "./state.js";
export { withSessionLock, LockTimeoutError } from "./lock.js";
export { createEngine } from "./engine.js";
