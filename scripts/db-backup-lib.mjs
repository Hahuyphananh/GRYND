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
export function qLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  // bigint / numeric / bytea / uuid / enum / text — all quoted strings.
  return `'${String(v).replace(/'/g, "''")}'`;
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
