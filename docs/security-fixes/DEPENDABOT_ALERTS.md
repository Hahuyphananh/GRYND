# Dependabot alerts — remediation (2026-10-07)

Audit of the npm dependency alerts across the repo, with fixes applied and the
remainder explained.

## How the alert list was obtained

The GitHub Dependabot alerts API needs authentication (`security_events` scope)
and this environment has no `gh` CLI and no token. The list was therefore
reproduced locally with `npm audit`, which consumes the same GitHub Advisory
Database, and cross-checked against the count GitHub itself reports on push.

Two counting systems apply here and they are **not** interchangeable:

- **Dependabot** opens one alert per advisory per affected package — this is the
  number shown in the repo's Security tab.
- **`npm audit`** counts one entry per vulnerable *package node*, so one advisory
  appears once for the vulnerable package and again for every dependency that
  pulls it in.

Three manifests were checked:

| Manifest | Dependabot alerts | `npm audit` nodes |
|----------|-------------------|-------------------|
| `package.json` (root) | 6 (2 critical, 3 high, 1 moderate) | 14 (2 critical, 10 high, 2 moderate) |
| `realtime-server/package.json` | 0 | 0 |
| `android/` (Gradle) | no separate pin — Capacitor resolves from `node_modules`, so the npm bump covers it | — |

The root figure is not an estimate: pushing this fix made GitHub report
`GitHub found 6 vulnerabilities on Hahuyphananh/GRYND's default branch
(2 critical, 3 high, 1 moderate)` — the pre-push graph, since Dependabot
re-scans asynchronously after the push. Those 6 map exactly to the advisories
below (Capacitor counts twice, once per platform package).

`.github/workflows/*` pin `actions/checkout@v4` and `actions/setup-node@v4`
(current majors), so there are no GitHub Actions alerts.

## Result

**6 → 1 Dependabot alerts** (14 → 8 by `npm audit` node count). Both critical
alerts and the moderate one are cleared. The single remaining alert is the
unfixable `braces` advisory.

This is confirmed by GitHub, not inferred: it reported 6 vulnerabilities when
the fix branch was pushed, and **1** afterwards —
`GitHub found 1 vulnerability on ... default branch (1 high)`, alert 312.

| Advisory | Sev | Package | Was | Now |
|----------|-----|---------|-----|-----|
| GHSA-rvm3-566m-v7fv | **critical** | `@capacitor/android`, `@capacitor/ios` | 8.3.4 | **8.5.2** ✅ |
| GHSA-wq5f-xc86-pv6w | high | `sharp` | 0.35.4 | **0.35.5** ✅ |
| GHSA-68fv-2mgg-jv7q | high | `source-map-js` | 1.2.1 | **1.2.2** ✅ |
| GHSA-rj75-hqrm-r3gf | moderate | `postcss-selector-parser` | 6.1.4 | **7.1.6** ✅ |
| GHSA-vfj7-8cjw-p6xm | high | `braces` (1 alert; 8 `npm audit` nodes) | 3.0.3 | **no fix exists** ❌ |

## What changed

`package.json` only (plus the regenerated `package-lock.json`):

- `@capacitor/android`, `@capacitor/ios`, `@capacitor/core` `^8.3.3` → `^8.5.2`
  and `@capacitor/cli` in step, so the four stay version-aligned.
- `overrides.sharp` `^0.35.4` → `^0.35.5`.
- `overrides["source-map-js"]` `^1.2.2` (new).
- `overrides["postcss-selector-parser"]` `^7.1.6` (new — forced major, see below).

Following the pattern already used for `esbuild`/`tar`/`uuid`/etc., transitive
advisories are pinned via `overrides` rather than by upgrading the direct
dependents.

### The Capacitor critical, in detail

The WebView navigation guard validated only scheme and host, not path, so a
frame navigation to `/_capacitor_http_interceptor_` was treated as in-app and
loaded caller-controlled content **at the app origin** — with access to
`localStorage`, cookies and every registered native plugin. Any surface that
renders user-controlled links (this app has chat) is a delivery vector.

The bump reaches all three ecosystems the advisory covers:

- **npm** — `@capacitor/android` / `@capacitor/ios` / `@capacitor/core` at 8.5.2.
- **Maven** (`com.capacitorjs:core`) — `android/capacitor.settings.gradle`
  resolves `:capacitor-android` from
  `../node_modules/@capacitor/android/capacitor`, so the native module follows
  the npm version. Nothing versioned is committed to bump.
- **Swift** (`capacitor-swift-pm`) —
  `ios/App/CapApp-SPM/Package.swift` declares `from: "8.0.0"`, an open range,
  and there is no committed `Package.resolved` pinning an old revision, so SPM
  resolves to 8.5.2.

> **Still required:** the advisory's own guidance is "upgrade, then rebuild and
> redistribute your application". This repo change only updates the dependency
> — the shipped iOS/Android binaries must be rebuilt and resubmitted before the
> fix is live for users. Run `npx cap sync` before the native build.

### Why the `postcss-selector-parser` major was forced

`^7.1.6` is the only version that clears GHSA-rj75-hqrm-r3gf, but Tailwind
3.4.19 and `postcss-nested` 6.2.0 both declare `^6`. The override was forced
deliberately and verified rather than assumed — see the evidence below. Neither
PSP 7.1.6 nor 6.1.4 declares `"type": "module"` or an `exports` map (both expose
`main: dist/index.js`), so there is no CJS/ESM breakage, and nothing in `src/`
imports it directly.

## Verification performed

| Check | Result |
|-------|--------|
| Dependabot alerts | 6 → 1 (GitHub reported 6 before the push, 1 after) |
| `npm audit` totals | 14 → 8 nodes (critical 2→0, moderate 2→0, high 10→8) |
| `npm run build` | exit 0 |
| Rendered CSS, PSP 6.1.4 vs 7.1.6 | **byte-for-byte identical** (272,140 bytes) |
| `sharp` 0.35.5 runtime | PNG encode + resize→JPEG OK |
| Test suites (20 files from `npm test`) | 233 pass, 1 fail |

The CSS comparison is the load-bearing check for the forced override: a
baseline build was produced with the override removed (which reinstalls PSP
6.1.4 nested under `tailwindcss/` and `postcss-nested/`), and the emitted
stylesheet was diffed against the PSP 7.1.6 build. Identical output means
Tailwind's selector processing is unaffected.

### Pre-existing breakage (not caused by this change)

`npm test` fails immediately, before any test runs, and one test fails on a
missing import. Both are missing files that are **not tracked in git** and are
unrelated to dependencies:

- `scripts/check-tabler-icons.mjs` — referenced by the `test:icons` step that
  `npm test` runs first, so `npm test` never reaches the real suites.
- `scripts/db-backup-lib.mjs` — imported by `tests/db-backup-restore.test.mjs`
  (`ERR_MODULE_NOT_FOUND`), which is the 1 failure above.

Restoring those two files will fix `npm test`.

## The remaining alert cannot be fixed by a version bump

`braces` **GHSA-vfj7-8cjw-p6xm** (stack exhaustion via deeply nested brace
patterns) affects `<= 3.0.3`, and the advisory's *Patched versions* field is
**"None"** — 3.0.3 is the newest release on npm, so no `overrides` value can
clear it. Dependabot raises a single alert for it, but `npm audit` lists eight
nodes because seven more packages pull `braces` in transitively:

| Package | Pulls `braces` in via |
|---------|----------------------|
| `micromatch` | direct dependency |
| `fast-glob` | `micromatch` |
| `globby` | `fast-glob` |
| `chokidar` (3.6.0) | `braces` |
| `next-pwa` | `globby` |
| `tailwindcss` (3.4.19) | `chokidar`, `fast-glob`, `micromatch` |
| `postcss-cli` (11.0.1) | `chokidar` |

These can only be cleared by removing the chains that pull `braces` in:

| Action | Clears | Cost |
|--------|--------|------|
| `tailwindcss` 3 → 4 | `tailwindcss`, and its `chokidar`/`fast-glob`/`micromatch` edges | Major migration: `tailwind.config.js` → CSS-first config, changed utility semantics. Tailwind 4 declares no dependencies at all, so it does drop the chain. |
| `postcss-cli` 11 → 12 | `postcss-cli`, one `chokidar` edge | Uses `chokidar@5` + `tinyglobby`; verify no CLI flag drift. |
| Replace `next-pwa` | `next-pwa`, `globby` | Abandoned upstream (last release 5.6.0, 2022). Note `npm audit`'s suggested "fix" is a **downgrade to 2.1.0**, which is not a real remedy. |

If you don't want to take those, this is a reasonable **Dependabot dismissal**:
`braces` is only reached through build-time glob processing driven by
developer-authored config, never by user input, so the practical exposure to
this DoS is low. That is a judgement call for you, not something to assume — it
is left in place rather than dismissed silently.

## Reproducing

```bash
npm audit                       # expect 8 high nodes, all via braces (1 Dependabot alert)

# Show only the root advisories (ignoring transitive duplicates)
npm audit --json | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const a=JSON.parse(s), seen=new Set();
  for(const v of Object.values(a.vulnerabilities||{}))
    for(const x of v.via||[]) if(typeof x==='object' && !seen.has(x.url))
      seen.add(x.url), console.log(x.severity, x.name, x.url.replace(/.*\//,''));
});"
```

For the authoritative Dependabot view (which also covers ecosystems `npm audit`
cannot see), authenticate the GitHub CLI:

```bash
gh auth login
gh api repos/Hahuyphananh/GRYND/dependabot/alerts \
  --paginate -q '.[] | "\(.security_advisory.severity) \(.dependency.package.name) \(.security_advisory.ghsa_id) \(.state)"'
```
