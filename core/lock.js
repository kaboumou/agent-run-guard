/**
 * Agent Run Guard — core/lock.js
 * Pure ESM, stdlib-only. Bounded per-session exclusive lock for the CLI's
 * read-modify-write cycle (R2): exclusive create, finite retry/backoff,
 * age-based stale takeover, release in `finally`, finite-timeout fail-open.
 */

export class LockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "LockTimeoutError";
    this.code = "AGENT_RUN_GUARD_LOCK_TIMEOUT";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockAgeMs(fs, lockFile) {
  try {
    const st = fs.statSync(lockFile);
    return Date.now() - Number(st.mtimeMs);
  } catch {
    return 0; // vanished or unreadable: not stale, just retry
  }
}

function readToken(fs, lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, "utf8");
    const obj = JSON.parse(raw);
    return typeof obj?.token === "string" ? obj.token : null;
  } catch {
    return null;
  }
}

/**
 * Run fn() while holding an exclusive lock file next to the state file.
 * - Acquire: fs.open with "wx" (fails if present) + owner token.
 * - Contended: bounded retry with jittered backoff until timeoutMs.
 * - Stale (older than staleMs by mtime): unlink + take over (crash-safe).
 * - Release: only when the file still holds OUR token, in `finally`.
 * - Timeout: throws LockTimeoutError (caller applies the documented
 *   fail-open fallback). Never waits forever.
 */
export async function withSessionLock(stateFile, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retryMs = opts.retryMs ?? 50;
  const staleMs = opts.staleMs ?? 15000;
  const lockFile = stateFile + ".lock";
  const fs = await import("node:fs");
  const path = await import("node:path");
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  } catch {
    // Directory creation is best-effort; openSync errors surface below.
  }
  const token = `${process.pid}:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let acquired = false;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), token }), "utf8");
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close errors; the lock file itself is what matters
        }
      }
      acquired = true;
    } catch (err) {
      if (err?.code !== "EEXIST" && err?.code !== "EPERM" && err?.code !== "EACCES" && err?.code !== "EBUSY") throw err;
      // EEXIST: someone holds it. EPERM/EACCES/EBUSY (notably Windows
      // transient file states, e.g. AV scans): treat like contention and
      // back off within the deadline instead of failing instantly.
      // Someone holds it (or just released it): stale-takeover or backoff.
      try {
        if (lockAgeMs(fs, lockFile) > staleMs) {
          try {
            fs.unlinkSync(lockFile);
          } catch {
            // lost the race to another taker; fall through to backoff
              }
        }
      } catch {
        // ignore inspection errors; backoff below
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `Agent Run Guard: lock timeout after ${timeoutMs}ms on ${lockFile}`
        );
      }
      const wait = Math.min(250, retryMs * (0.5 + Math.random()));
      await sleep(wait);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if (readToken(fs, lockFile) === token) fs.unlinkSync(lockFile);
    } catch {
      // Best-effort release; a stale file is taken over by the next waiter.
    }
  }
}
