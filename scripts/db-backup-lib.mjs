// scripts/db-backup-lib.mjs
//
// Pure, dependency-free helpers shared by scripts/db-backup.mjs and
// scripts/db-restore.mjs. Kept free of any database/IO so they can be
// unit-tested without a live Postgres (see tests/db-backup-restore.test.mjs).

/** Quote a SQL identifier (table/column/etc.), doubling embedded quotes. */
export function qIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Render a JS row value as a SQL literal. The dump writes data as INSERTs
 * for maximum portability (works across providers, no COPY protocol
 * needed, no pg-copy-streams dependency).
 */
export function qLiteral(v, dataType = "") {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  // `pg` returns bytea as a Buffer; String(buffer) would be garbage.
  if (Buffer.isBuffer(v)) return `decode('${v.toString("hex")}', 'hex')`;
  // `pg` hands back a JS array for BOTH a native `text[]` column and a json
  // array inside a json/jsonb column, and the two need different literals: a
  // native array uses `{"a","b"}` (JSON's `["a","b"]` is rejected as a
  // malformed array literal), while a json column keeps JSON. Only the column
  // type can tell them apart, so the caller passes it in.
  const isJson = dataType === "json" || dataType === "jsonb";
  if (Array.isArray(v)) return isJson ? quoteString(JSON.stringify(v)) : pgArrayLiteral(v);
  // `pg` parses json/jsonb columns into JS values. Without re-serialising
  // them every such column would restore as the text "[object Object]".
  if (typeof v === "object") return quoteString(JSON.stringify(v));
  // bigint / numeric / uuid / enum / text — all quoted strings.
  return quoteString(String(v));
}

/** Render a JS array as a Postgres array literal, e.g. `'{"a","b"}'`. */
function pgArrayLiteral(values) {
  const parts = values.map((x) => {
    if (x === null || x === undefined) return "NULL";
    if (typeof x === "number") return Number.isFinite(x) ? String(x) : "NULL";
    if (typeof x === "boolean") return x ? "true" : "false";
    const inner = typeof x === "object" ? JSON.stringify(x) : String(x);
    // Inside an array literal, `"` and `\\` are escaped with a backslash.
    return `"${inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return quoteString(`{${parts.join(",")}}`);
}

/**
 * A single-quoted SQL literal. Strings containing a backslash or a control
 * character are emitted as an E'' string with those characters escaped: the
 * dump is split into statements line by line, so a literal must never span
 * lines (a value containing a newline followed by `;` would otherwise
 * truncate the statement mid-INSERT).
 */
function quoteString(s) {
  if (/[\\\n\r\t]/.test(s)) {
    const escaped = s
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "''")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `E'${escaped}'`;
  }
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Split a plain-SQL dump into statements. Works on the format emitted by
 * db-backup (each statement ends with a `;` at the end of a line; values
 * never end a line in `;` — every INSERT row is `  ,(...)` and the
 * terminator is a bare `;` line). Comment-only and blank lines are
 * dropped.
 */
export function splitStatements(sql) {
  const statements = [];
  let buf = [];
  for (const raw of sql.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("--")) continue;
    buf.push(line);
    if (line.endsWith(";")) {
      statements.push(buf.join("\n"));
      buf = [];
    }
  }
  if (buf.length) statements.push(buf.join("\n"));
  return statements.filter(Boolean);
}

/**
 * Stable foreign-key ordering: parents before children. Input is the FK
 * rows as returned by information_schema (child/parent table names).
 * Cyclic/self-referencing leftovers are appended rather than dropped.
 */
export function orderByDependencies(tables, fkRows) {
  const childrenOf = new Map();
  for (const r of fkRows) {
    if (r.parent === r.child) continue;
    if (!childrenOf.has(r.child)) childrenOf.set(r.child, new Set());
    childrenOf.get(r.child).add(r.parent);
  }
  const remaining = new Set(tables);
  const ordered = [];
  let guard = 0;
  while (remaining.size && guard++ < tables.length * 2) {
    let progressed = false;
    for (const t of [...remaining]) {
      const deps = [...(childrenOf.get(t) || [])].filter((d) => remaining.has(d));
      if (deps.length === 0) {
        ordered.push(t);
        remaining.delete(t);
        progressed = true;
      }
    }
    if (!progressed) {
      ordered.push(...remaining);
      remaining.clear();
    }
  }
  return ordered;
}
