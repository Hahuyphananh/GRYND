# Native App Build & Google Play Submission

GRYND ships as a **Capacitor wrapper that loads the live web app** from
`https://www.grynd.dedyn.io` — see `capacitor.config.ts`. The Android project in
`android/` is already renamed to the real identity (`com.grynd.app` / "GRYND"),
has launcher art at every density, and declares only the `INTERNET` permission.

This doc covers everything from an empty clone to a submitted Play release:
signing, the AAB, version bumps, the Play Console steps, and the repo-specific
gates that must hold before you upload.

> **The app has no web assets of its own.** `server.url` means every screen is
> server-rendered by the deployed website. A `cap sync` therefore does not copy
> a `webDir`, and **any web deploy is immediately live in the app** — for better
> and worse. The exception is `android/app/src/main/assets/public/error.html`,
> the local recovery page (`server.errorPath`), which _is_ committed.

---

## 1. Prerequisites

| Requirement                | Notes                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **JDK 21+**                | Gradle will not start without it. Android Studio's bundled JBR works; so does any standalone JDK. Set `JAVA_HOME`.      |
| **Android SDK**            | Installed via Android Studio. `android/local.properties` must point at it (`sdk.dir=…`). Git-ignored, machine-specific. |
| **Node + deps**            | `npm install` — the `@capacitor/*` projects are resolved from `node_modules`.                                           |
| `android/local.properties` | If missing, Gradle fails with "SDK location not found". Open the project once in Android Studio, or create it by hand.  |

Target levels are already current: `minSdk 24`, `compileSdk`/`targetSdk 36`
(`android/variables.gradle`). Play requires target API 35+, so there is nothing
to bump here.

**Environment variables are NOT part of the app build.** Because the app loads a
remote URL, Clerk keys, `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_SOCKET_URL` and the
rest live on the deployed website. Changing them needs a web deploy, not an app
release — but it also means a misconfigured website breaks the installed app.

---

## 2. Signing (do this once)

Google Play will not accept an unsigned bundle. Release signing lives in
`android/key.properties`, **not** in the build script, so no password reaches git
and the same setup works locally and in CI.

```bash
# 1. Create the keystore. It cannot be recreated — back it up.
keytool -genkeypair -v \
  -keystore "$HOME/keys/grynd-upload.keystore" \
  -alias grynd-upload \
  -keyalg RSA -keysize 4096 -validity 10000

# 2. Fill in the properties file (template is committed)
cp android/key.properties.example android/key.properties
```

`android/key.properties`:

```properties
storeFile=C:/Users/you/keys/grynd-upload.keystore
storePassword=...
keyAlias=grynd-upload
keyPassword=...
```

Two things that fail silently:

- **Use forward slashes in `storeFile`, even on Windows.** `java.util.Properties`
  reads `\` as an escape, so `C:\Users\me` becomes `C:Usersme`. A relative path
  resolves against `android/app/`.
- The keystore may live **outside the repo**. Keeping it in a password-manager
  backed folder means `git clean -xdf` or a fresh clone cannot destroy it.

What `android/app/build.gradle` does with it: reads the file if present, requires
all four keys (failing with a named error if one is missing), and **leaves the
release build unsigned when the file is absent** so a fresh clone can still run
`cap sync`, `assembleDebug` and lint.

Git-ignored: `key.properties`, `*.keystore`, `*.jks`
(`android/.gitignore` + the project `.gitignore`). `key.properties.example` is
deliberately **not** ignored.

### Play App Signing

New apps use **Play App Signing** by default: you upload a bundle signed with
your _upload_ key, and Google re-signs it with the _app signing_ key it holds.
Consequences:

- Losing the upload key is recoverable (request a reset in Play Console).
- The certificate Play reports is **not** your keystore's — don't panic.
- Keep the upload key stable across releases so Play can verify continuity.

---

### Signing in CI

`.github/workflows/android-release.yml` builds and signs the bundle on a
GitHub-hosted runner using the **same** `android/key.properties` contract
described above — the local flow is unchanged, CI just materialises that file
on the runner. Add four repository secrets (Settings → Secrets and variables →
Actions):

| Secret                    | Contents                                                                 |
| ------------------------- | ------------------------------------------------------------------------ |
| `ANDROID_KEYSTORE_BASE64` | the upload keystore, base64-encoded (`base64 -w0 grynd-upload.keystore`) |
| `ANDROID_STORE_PASSWORD`  | `storePassword`                                                          |
| `ANDROID_KEY_ALIAS`       | `keyAlias`                                                               |
| `ANDROID_KEY_PASSWORD`    | `keyPassword`                                                            |

The job runs `cap sync` + `bundleRelease`, **refuses to hand back a bundle that
`jarsigner` does not verify** (an unsigned bundle is what a missing
`key.properties` silently produces), asserts the packaged
`capacitor.config.json` still carries `GRYNDApp/1.0`, and deletes the keystore
and properties file afterwards. It does not publish: the AAB is a 14-day
workflow artifact and you upload it to Play Console.

Trigger it from **Actions → android-release**, or push a tag matching
`android-v*`. It builds whatever `versionCode` is committed — bump that in the
PR before tagging, because Play refuses a reused code.

### Publishing to Internal testing (optional, automatic)

`android-release.yml` has a second job, `publish-internal`, that uploads the
signed AAB to the Play **internal testing** track through the Play Developer API
(`scripts/publish-play-internal.mjs` — no third-party action and no dependency,
so the service-account key never leaves the job).

One-time Play Console setup:

1. Google Cloud console → enable the **Google Play Android Developer API** and
   create a service account in that project; download its JSON key.
2. Play Console → **Users and permissions** → invite the service account's
   `client_email` with **Release to testing tracks**. Do not grant admin: this
   workflow can publish to internal testing only.
3. GitHub → Settings → Secrets and variables → Actions:
   - secret `PLAY_SERVICE_ACCOUNT_JSON` — the JSON key, verbatim
   - variable `PLAY_PUBLISH_ENABLED` — `true` enables tag-triggered publishing
4. Create the **`android-play` environment** with at least one required
   reviewer. A referenced environment with no protection rules publishes
   **without approval**, so this step is what makes the release reviewed.

The job downloads the artifact the build job produced and runs the API's
transactional "edit" flow: open an edit → upload the bundle → attach its
versionCode to the track → commit. A failure before the commit leaves Play
untouched, and the open edit is deleted. Images, release notes and the roll-out
fraction are untouched.

It never promotes beyond `internal`. Moving a build to closed or production is
a deliberate human step in Play Console.

## 3. Version bumps (every upload)

Both values live in `android/app/build.gradle`, in `defaultConfig`:

```gradle
versionCode 1        // integer — Play's upload counter
versionName "1.0"    // string  — what humans/downloads show
```

Rules that bite:

| Rule                                                           | Why                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `versionCode` must **strictly increase** on every upload       | Play rejects a reused code, for any track, forever                                  |
| `versionCode` can never **decrease**                           | Not even to fix a mistake — always go forward                                       |
| `versionName` is free-form                                     | Semver (`1.4.0`) is the convention here; it is cosmetic and can repeat              |
| Bump **before** building, not after                            | The AAB carries the value; editing Gradle afterwards does not change a built bundle |
| A rejected/taken-down release still consumes its `versionCode` | Plan a bump per fix                                                                 |

Suggested habit: `versionName` tracks the site release, `versionCode` is a plain
counter. If you later want one place to edit, move both into
`android/variables.gradle` and reference them from `build.gradle`.

The counter is enforced, not just documented: `scripts/check-android-version.mjs`
is run by the `android-version-guard` workflow on any pull request touching
`android/**` (compared against the PR's base branch) and by the release workflow
before it builds (compared against the previous `android-v*` tag). Only
`versionCode` is checked — `versionName` is cosmetic.

---

## 4. Build the Play bundle (AAB)

Google Play requires an **AAB**, not an APK, for new apps.

```bash
npx cap sync android          # after ANY capacitor.config.ts change
cd android
./gradlew bundleRelease       # gradlew.bat from cmd.exe
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`

- **Signed** when `android/key.properties` exists — this is the file you upload.
- **Unsigned** when it does not. Gradle still produces the file, but Play rejects
  it. If you need an uploadable bundle and got an unsigned one, the properties
  file is missing or unreadable.

### Verify before uploading

```bash
# Package identity, the remote URL, and the native-shell marker
unzip -p app-release.aab base/assets/capacitor.config.json
# Expect: https://www.grynd.dedyn.io/  AND  "appendUserAgent": "GRYNDApp/1.0"
# (Capacitor pretty-prints this file; match with '[[:space:]]*' around the colon)

# Signature present (signed builds only; expect "jar verified")
jarsigner -verify -verbose -certs app-release.aab | grep -i "jar verified"
```

The `appendUserAgent` line is **not optional** — it is what keeps AdSense and
Stripe checkout out of the app (see §5). A bundle built before
`npx cap sync android` carries the old config and will serve ads and in-app
checkout, which is a Play policy problem and an AdSense policy problem at once.

### Optional sideload APK (testers, not the store)

```bash
cd android
./gradlew assembleRelease
# android/app/build/outputs/apk/release/app-release.apk

apksigner verify --print-certs app-release.apk
```

---

## 5. Repo gates that must hold before uploading

These are enforced in code, but an upload can still ship a stale bundle. Check
them explicitly.

| Gate                            | Where                                                                        | What must be true                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native-shell marker             | `capacitor.config.ts` → `appendUserAgent: 'GRYNDApp/1.0'`                    | Present, and `cap sync` has run                                                                                                                             |
| **AdSense off in app**          | `src/components/AdSenseScript.tsx`, `AdSlot.tsx`, `src/lib/native/shell*.ts` | Both return `null` for the shell's UA. AdSense is licensed for web pages; in-app serving is AdMob's territory and risks the account that monetises the site |     | **Stripe checkout off in app** | `POST /api/coins/checkout`, `POST /api/stripe/subscribe`, `GET /api/coins/packages` | `403` / empty catalog for the shell's UA. Play requires Play Billing for digital goods consumed in-app |
| **Hilltop banner off in app**   | `src/components/ads/HilltopBanner.tsx`                                       | Gate 0 returns `null` before the provider gates, so the app receives no container and no snippet                                                            |
| **Post-match video off in app** | `GET /api/ads/post-match`                                                    | Answers `enabled: false` for the shell's UA; the result screen then releases whatever exit action it was holding                                            |
| Only the `INTERNET` permission  | `android/app/src/main/AndroidManifest.xml`                                   | No new permissions — each one needs a justification in Play Console                                                                                         |
| No push notification wiring     | `android/app/build.gradle`                                                   | Without `google-services.json` the google-services plugin is skipped; that is correct until FCM is actually added                                           |

All three ad providers are gated, and `tests/native-ad-gates.test.mjs`
(`npm run test:native-ads`) fails if any gate is removed — the signal that the
Play Console **Ads = No** answer has to be revisited.

Run the contracts that protect these:

```bash
npm run test:ads            # ad surfaces, incl. the native-shell branch
npm run test:coin-checkout  # the checkout route's server-side gates
npm run test:upgrade-pro
```

---

## 6. Play Console submission

### 6.1 Account and app

1. **Developer account** — $25 one-time, plus identity verification.
   A **personal (individual)** account created after 13 Nov 2023 must run
   **closed testing with at least 12 testers for 14 continuous days** before it
   can apply for production access. Organization accounts are exempt. This is
   the longest lead-time item: start the test track early.
2. **Create the app** — name "GRYND", type App, Free.
3. **Package name `com.grynd.app` is permanent.** It cannot be changed after the
   first upload; changing it later means a new listing and losing installs.

### 6.2 Tracks

Upload the AAB to **Internal testing** first, then **Closed**, then
**Production**. An AAB works on every track. Watch the **pre-launch report**: it
runs on real devices and is where WebView problems you cannot reproduce locally
surface.

### 6.3 App content (the section that gets apps rejected)

| Item                              | What to enter                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data safety**                   | Transcribe `docs/play-data-safety-form.md` verbatim — it is grounded in the real data flows (Clerk, PostHog, Sentry, Neon)                                                                                                                                                                                                       |
| **Ads**                           | Declare **yes only if** ads actually render in the app. With the gate in §5 holding, the honest answer is no for AdSense; if VAST/Hilltop still run, say yes                                                                                                                                                                     |
| **Content rating**                | IARC questionnaire. The token/wagering features drive this (simulated gambling, virtual currency). Answer for what the app _does_, not what the marketing says                                                                                                                                                                   |
| **Target audience**               | 18+; not child-directed. Do not opt into the Families programme                                                                                                                                                                                                                                                                  |
| **App access**                    | **Critical.** GRYND requires a login, so provide working demo credentials and step-by-step instructions. A reviewer who hits a sign-up wall or the offline error page rejects the app                                                                                                                                            |
| **Account deletion**              | Play requires a **web URL** where deletion can be requested, in addition to the in-app path. The in-app route is `POST /api/delete-account` (reached from the profile page), and the public URL Play asks for is **`/account-deletion`** — footer-linked, no sign-in required, guarded by `tests/account-deletion-page.test.mjs` |
| **Financial features / gambling** | Declare honestly: coins are bought with real money and used to enter games. Expect scrutiny; this is a product decision, not a form-filling trick                                                                                                                                                                                |

### 6.4 Store listing assets

| Asset             | Requirement           | In this repo                                                                                                                                                |
| ----------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App icon          | 512×512 PNG, 32-bit   | `public/icon-512.png`                                                                                                                                       |     | Feature graphic | 1024×500 | `play-store/feature-graphic.jpg` (`npm run assets:play-store`) |
| Phone screenshots | ≥2, long edge ≥1080px | `play-store/screenshots/` — 1080×1920 renders of the real app (`npm run assets:play-store`); the other two dirs are **web** QA captures, not listing assets |
| Short description | ≤80 chars             | —                                                                                                                                                           |
| Full description  | ≤4000 chars           | —                                                                                                                                                           |
| Privacy policy    | Public URL            | Live at `/privacy-policy`                                                                                                                                   |

The app already ships localized copy (EN/FR/ES) — a localized listing is
available if you want it, but English-only is fine for v1.

### 6.5 Review notes

Play gives you a free-text field for reviewers. Use it to state that the app is
a native shell around a live service that requires an account, and to name the
native integrations (system back button, safe areas, haptics, keyboard handling,
splash/status bar, offline recovery page). "WebView of a website" is the single
most common rejection under _Spam and minimum functionality_, and this is the
field where you answer it.

---

## 7. Known risks of the remote-URL architecture

- **A domain change breaks every installed copy.** `server.url` is baked into the
  bundle. Moving off `www.grynd.dedyn.io` strands existing installs until they
  update. Treat the host as an API contract.
- **Site downtime during review is a rejection.** The reviewer sees `error.html`,
  not the app.
- **The site must stay backwards-compatible with shipped shells.** Old app
  versions call old endpoints forever; removing or renaming one breaks them.
- Bundling the web app instead is not available here: this is a Next.js app with
  SSR, API routes, Clerk and Stripe webhooks, so a static export is not possible.
  Accept the wrapper, pin the domain, and keep the API stable.

---

## 8. iOS (for completeness)

Requires macOS + Xcode — cannot be produced on this Windows machine.

1. `npx cap sync ios`
2. Open `ios/App/App.xcodeproj`, set the **Team** under Signing & Capabilities
   (bundle id `com.grynd.app`). Needs an Apple Developer account ($99/year) even
   for non-App-Store distribution.
3. Product → Archive → **Distribute App** → Direct Distribution / Ad Hoc.
4. App Store Connect additionally requires the privacy manifest already present
   at `ios/App/App/PrivacyInfo.xcprivacy`.

---

## 9. Release checklist

Copy this into the release PR/issue:

```
[ ] Web deploy is live and healthy (/api/health, realtime /health)
[ ] capacitor.config.ts appendUserAgent present
[ ] npx cap sync android run after the last config change
[ ] versionCode bumped in android/app/build.gradle
[ ] android/key.properties present, keystore backed up
[ ] ./gradlew bundleRelease → signed app-release.aab
[ ] unzip -p …/capacitor.config.json shows the URL + GRYNDApp marker
[ ] jarsigner -verify → "jar verified"
[ ] Installed on a real device: sign in, play a match, background/foreground,
    airplane mode shows the recovery page
[ ] npm run test:ads && npm run test:coin-checkout
[ ] Play: data safety, ads, content rating, app access + demo credentials
[ ] Play: account-deletion URL live
[ ] Store listing assets uploaded
[ ] Review notes explain the native shell and its native integrations
```

---

## See also

- `docs/play-data-safety-form.md` — exact Data safety answers
- `docs/LAUNCH_CHECKLIST.md` — pre-launch items needing dashboard/env access
- `docs/app-store-app-privacy.md` — the iOS privacy answers
- `android/key.properties.example` — signing template
