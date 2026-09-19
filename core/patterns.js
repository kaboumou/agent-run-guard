/**
 * Agent Run Guard — core/patterns.js
 * Pure ESM, stdlib-only. High-confidence dangerous-command patterns and
 * secret patterns for file-write scanning.
 *
 * Design: small default set, default action warn (configurable to deny).
 * Patterns match command text assembled from tool args (never executed).
 */

/** Split an `rm` command line into per-invocation argument segments. */
function rmSegments(cmd) {
  const segs = [];
  const re = /(^|[\s;&|])rm\s+([^;\n|&]*)/gi;
  let m;
  while ((m = re.exec(cmd)) !== null) segs.push(m[2]);
  return segs;
}

/** True when a flag cluster contains a short letter or an exact long flag. */
function hasRmFlag(segment, letter, long) {
  for (const raw of String(segment).split(/\s+/)) {
    const tok = raw.toLowerCase();
    if (tok === long) return true;
    if (/^-[^-]/.test(tok) && tok.slice(1).split("").includes(letter)) return true;
  }
  return false;
}

function rmTargets(segment, kind) {
  if (kind === "root") return /(^|\s)\/(\s|$|;|&|\||"|')/.test(segment);
  // home: ~, $HOME, %USERPROFILE%
  return /(\s|^)~(\/|$|\s)/.test(segment) ||
    /(\$HOME|%USERPROFILE%)(\\|\/|$|\s)/i.test(segment);
}

function rmHits(cmd, kind) {
  return rmSegments(cmd).some(
    (seg) =>
      rmTargets(seg, kind) &&
      hasRmFlag(seg, "r", "--recursive") &&
      hasRmFlag(seg, "f", "--force")
  );
}

export const DANGEROUS_PATTERNS = [
  {
    id: "rm-rf-root",
    description: "recursive force delete of filesystem root (any flag form)",
    // rm -rf / | rm -fr / | rm -r -f / | rm --recursive --force / ...
    test: (cmd) => rmHits(cmd, "root"),
  },
  {
    id: "rm-rf-home",
    description: "recursive force delete of home directory (any flag form)",
    test: (cmd) => rmHits(cmd, "home"),
  },
  {
    id: "git-push-force",
    description: "force push (rewrites shared history)",
    // --force or short -f (any position after push)
    test: (cmd) =>
      /\bgit\s+push\b/i.test(cmd) && /(^|\s)(--force|-f)(\s|$)/.test(cmd),
  },
  {
    id: "git-reset-hard",
    description: "hard reset (discards uncommitted work)",
    test: (cmd) => /git\s+reset\s+--hard/i.test(cmd),
  },
  {
    id: "drop-table",
    description: "SQL DROP TABLE",
    test: (cmd) => /\bDROP\s+TABLE\b/i.test(cmd),
  },
  {
    id: "curl-pipe-sh",
    description: "remote script piped to shell",
    test: (cmd) =>
      /\bcurl\b[^\n|&;]*\|\s*(sh|bash)\b/i.test(cmd) ||
      /\bwget\b[^\n|&;]*\|\s*(sh|bash)\b/i.test(cmd),
  },
  {
    id: "ps-remove-root",
    description: "PowerShell recursive force-remove of drive root or home (flag order free)",
    test: (cmd) =>
      /(^|[\s;&|])(Remove-Item|\bri\b)\b/i.test(cmd) &&
      /-Recurse\b/i.test(cmd) &&
      /-Force\b/i.test(cmd) &&
      /("[A-Z]:[\\/]"|[A-Z]:[\\/]($|\s)|~(\/|$|\s)|\$HOME|\$env:USERPROFILE)/i.test(
        cmd
      ),
  },
  {
    id: "env-exfil",
    description: ".env content sent over the network",
    test: (cmd) =>
      /\.env/i.test(cmd) &&
      /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|\bnc\b|ssh\s)\b/i.test(cmd),
  },
];

export const SECRET_PATTERNS = [
  {
    id: "aws-key",
    description: "AWS access key id",
    test: (text) => /\bAKIA[0-9A-Z]{16}\b/.test(text),
  },
  {
    id: "github-token",
    description: "GitHub token",
    test: (text) => /\bghp_[A-Za-z0-9]{20,}\b/.test(text),
  },
  {
    id: "sk-secret",
    description: "sk- style API secret",
    test: (text) => /\bsk-[A-Za-z0-9-_]{8,}\b/.test(text),
  },
  {
    id: "private-key",
    description: "PEM private key block",
    test: (text) => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text),
  },
];

/** Collect command-ish text from an args object (command, script, args arrays). */
export function commandText(args) {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  if (Array.isArray(args)) return args.map(commandText).join(" ");
  if (typeof args === "object") {
    const parts = [];
    for (const key of ["command", "script", "cmd", "text", "input", "content"]) {
      if (typeof args[key] === "string") parts.push(args[key]);
    }
    // Include remaining string values (covers harness-specific arg shapes).
    for (const [k, v] of Object.entries(args)) {
      if (["command", "script", "cmd", "text", "input", "content"].includes(k)) continue;
      if (typeof v === "string") parts.push(v);
      else if (Array.isArray(v)) parts.push(commandText(v));
    }
    return parts.join("\n");
  }
  return String(args);
}

/** Collect all string values (for secret scanning of file-write content). */
export function allText(args) {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  if (Array.isArray(args)) return args.map(allText).join("\n");
  if (typeof args === "object")
    return Object.values(args).map(allText).join("\n");
  return "";
}

/** Return the ids of dangerous patterns matching this tool call. */
export function matchDangerous(tool, args) {
  const cmd = commandText(args);
  if (!cmd) return [];
  const hits = [];
  for (const p of DANGEROUS_PATTERNS) {
    try {
      if (p.test(cmd)) hits.push(p.id);
    } catch {
      // A broken pattern must never break the guard.
    }
  }
  return hits;
}

const WRITE_TOOL_RE = /write|edit|create|apply|patch|save/i;

/** True when the tool looks like a file write (or args carry file content). */
export function looksLikeWrite(tool, args) {
  if (WRITE_TOOL_RE.test(String(tool))) return true;
  if (args && typeof args === "object") {
    for (const k of ["content", "text", "body", "data", "patch", "edits"]) {
      if (typeof args[k] === "string" && args[k].length > 0) return true;
    }
  }
  return false;
}

/** Return the ids of secret patterns found in a file-write-like call. */
export function matchSecrets(tool, args) {
  if (!looksLikeWrite(tool, args)) return [];
  const text = allText(args);
  if (!text) return [];
  return matchSecretIds(text);
}

/** Return secret-pattern ids present anywhere in text (no tool gating). */
export function matchSecretIds(text) {
  if (!text) return [];
  const hits = [];
  for (const p of SECRET_PATTERNS) {
    try {
      if (p.test(text)) hits.push(p.id);
    } catch {
      // Never break the guard on a pattern error.
    }
  }
  return hits;
}

const SHELL_REDIRECT_RE = />{1,2}\s*([^|\s;&]+)/;
const SHELL_REDIRECT_NOISE = new Set(["&1", "&2", "&-", "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "NUL"]);

/** Shell/PS forms that write command text into a file (high-confidence set). */
export function shellWriteForms(text) {
  const forms = [];
  try {
    const s = String(text ?? "");
    if (!s) return forms;
    const m = SHELL_REDIRECT_RE.exec(s);
    if (m && !SHELL_REDIRECT_NOISE.has(m[1].toUpperCase()) && !m[1].startsWith("&")) {
      forms.push("redirect");
    }
    if (/<<-?\s*['"]?\w+/.test(s)) forms.push("heredoc");
    if (/\|\s*tee\b/i.test(s)) forms.push("tee");
    for (const cmdlet of ["Set-Content", "Out-File", "Add-Content"]) {
      if (new RegExp(`\\b${cmdlet}\\b`, "i").test(s)) {
        forms.push(cmdlet.toLowerCase());
        break;
      }
    }
  } catch {
    // Never break the guard on a detection error.
  }
  return forms;
}

/**
 * Secrets smuggled through shell write forms (`>`, `>>`, heredoc, `| tee`,
 * Set-Content/Out-File/Add-Content) in command text. Applies to any tool —
 * a Bash `echo <secret> > file` bypasses structured Write/Edit scanning.
 * Returns { patterns, forms }; empty patterns means no hit.
 */
export function matchShellWriteSecrets(tool, args) {
  void tool;
  const text = commandText(args);
  if (!text) return { patterns: [], forms: [] };
  const forms = shellWriteForms(text);
  if (forms.length === 0) return { patterns: [], forms: [] };
  return { patterns: matchSecretIds(text), forms };
}
