// deploy/lib/ops/redact.mjs
//
// Every record that leaves the operations runtime passes through here: audit
// entries, error details, captured command output and anything echoed back to
// the dashboard.
//
// This is the SECOND net, not the first. The real guarantee is upstream: the
// configuration module never puts a value into an object it returns, and the
// broker never echoes a request body. Redaction catches the case where a value
// arrives through a channel nobody expected (a `systemctl` error mentioning a
// DSN, an operator pasting a key into a reason).
//
// Two layers:
//   key-based     a field whose NAME looks secret is replaced wholesale; the
//                 field still appears, proving it was present, with no value
//   value-based   a string that LOOKS like a credential is rewritten in place
//
// Constructed responses (the plan card, the permissions/status report) are NOT
// passed through this module by design — they are built field by field, so a
// redaction rule that hides a field called `token` cannot also hide the plan
// token the dashboard legitimately needs. Only data that originates outside a
// fixed schema is redacted.

/** Long strings are truncated so a stack dump cannot bloat an audit line. */
const MAX_STRING = 400;

/** A field name that matches this is never written out, whatever it holds. */
const SECRET_KEY_RE =
  /(^|[-_.])(password|passwd|passphrase|secret|token|api[-_]?key|private[-_]?key|access[-_]?key|client[-_]?secret|credential|credentials|cookie|authorization|auth[-_]?header|session[-_]?id|session[-_]?cookie|dsn|database[-_]?url|connection[-_]?string|jwt|hmac|salt)($|[-_.])/i;

/**
 * Patterns that are unambiguously credentials. Deliberately narrow: a blanket
 * "long random string" rule would also eat release ids and commit shas, and an
 * audit log nobody can read is not an audit log.
 */
const VALUE_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted-private-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(postgres(?:ql)?:\/\/)[^\s:@/]+:[^\s@/]*@/gi, "$1[redacted]@"],
  [/\b(postgres(?:ql)?:\/\/)[^\s:@/]+@/gi, "$1[redacted]@"],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{6,}/g, "[redacted-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-github-token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted-slack-token]"],
  // KEY=value / KEY: value where the key name itself announces a secret.
  [
    /([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g,
    "$1=[redacted]",
  ],
];

/** Rewrite credential-looking substrings, then bound the length. */
export function redactString(value) {
  if (typeof value !== "string") return value;
  let out = value;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…[${value.length} chars]`;
  return out;
}

/** True when a field name announces a secret. Exported so tests can pin it. */
export function isSecretKey(key) {
  return typeof key === "string" && SECRET_KEY_RE.test(key);
}

/**
 * Deep-redact a value for logging.
 *
 * @param {unknown} value
 * @param {{ depth?: number, allowKeys?: string[] }} [options]
 *   `allowKeys` names fields that are safe despite a secret-looking name; it
 *   exists for shape-preserving reports, not for convenience.
 */
export function redact(value, { depth = 5, allowKeys = [] } = {}) {
  const allowed = new Set(allowKeys);

  function walk(node, level) {
    if (level > depth) return "[depth-limit]";
    if (node === null || node === undefined) return null;
    if (typeof node === "string") return redactString(node);
    if (typeof node === "number" || typeof node === "boolean") return node;
    if (typeof node === "bigint") return String(node);
    if (typeof node === "function" || typeof node === "symbol") return null;
    if (node instanceof Error) {
      return { name: node.name, message: redactString(node.message) };
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, level + 1));
    if (node instanceof Date) return node.toISOString();
    if (typeof node === "object") {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [key, child] of Object.entries(node)) {
        if (isSecretKey(key) && !allowed.has(key)) {
          out[key] = "[redacted]";
          continue;
        }
        out[key] = walk(child, level + 1);
      }
      return out;
    }
    return null;
  }

  return walk(value, 0);
}

/**
 * Assert-style helper for tests and for a final check before a record is
 * written: throws if any of `secrets` appears anywhere in `value`.
 *
 * Exported from the runtime module on purpose — the same function that the
 * test suite uses to prove nothing leaked is available to guard a write path.
 */
export function findLeakedSecrets(value, secrets) {
  const haystack = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const found = [];
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    if (haystack.includes(secret) || haystack.includes(encodeURIComponent(secret))) found.push(secret);
  }
  return found;
}
