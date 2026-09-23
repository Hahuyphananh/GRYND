# Native App Build (downloadable APK / IPA)

GRYND ships as a Capacitor wrapper that loads the live web app from
`https://www.grynd.dedyn.io` (see `capacitor.config.ts`). This doc covers
producing a signed, distributable build — the identity placeholders have
been replaced (`com.grynd.app` / "GRYND"), so the output no longer looks
like a template project.

## Before building

1. Confirm `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_SOCKET_URL`, Clerk keys, etc.
   are baked into the **deployed** web app — the native app loads the remote
   URL, so runtime env vars live on the server, not in the build.
2. **Remote-URL caveat**: because the app loads from a URL, a domain change
   after install breaks the installed app until the user reinstalls. If that
   risk matters, switch to a bundled build (`webDir` pointing at `out/`) so
   the app ships its own copy of the web assets.

## Android — signed APK

1. Install dependencies: Node, Java 17+, Android SDK (Android Studio).
2. Sync native projects after any `capacitor.config.ts` change:
   ```bash
   npx cap sync android
   ```
3. Create a signing keystore (once):
   ```bash
   keytool -genkey -v -keystore grynd-release.keystore -alias grynd \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
   Store the keystore + passwords somewhere safe (it cannot be recreated).
4. Wire release signing into `android/app/build.gradle`:
   ```gradle
   android {
       signingConfigs {
           release {
               storeFile file('grynd-release.keystore')
               storePassword System.getenv("GRYND_STORE_PASSWORD")
               keyAlias "grynd"
               keyPassword System.getenv("GRYND_KEY_PASSWORD")
           }
       }
       buildTypes {
           release {
               signingConfig signingConfigs.release
               minifyEnabled false
           }
       }
   }
   ```
5. Build:
   ```bash
   cd android
   GRYND_STORE_PASSWORD=... GRYND_KEY_PASSWORD=... ./gradlew assembleRelease
   ```
   APK lands in `android/app/build/outputs/apk/release/app-release.apk`.

### Verify a release APK

```bash
# Confirm the package and signing
apksigner verify --print-certs app-release.apk
# or
keytool -printcert -jarfile app-release.apk | head
# Confirm it points at the live site (strings should contain grynd.dedyn.io)
unzip -p app-release.apk assets/capacitor.config.json
# Expected: https://www.grynd.dedyn.io/
```

## iOS — signed IPA

Requires macOS + Xcode (cannot be done on this Windows machine).

1. `npx cap sync ios`
2. Open `ios/App/App.xcodeproj` in Xcode.
3. Set the **Team** under Signing & Capabilities (bundle id
   `com.grynd.app`), which requires an Apple Developer account
   ($99/year) — needed even for sideloading outside the App Store.
4. Product → Archive, then **Distribute App** → "Direct Distribution"
   (or "Ad Hoc") to get a shareable IPA.

## Distribution notes (no app stores)

- Android APKs are directly installable (allow "install unknown apps").
- iOS IPAs need a signed device profile; the practical route without the
  App Store is TestFlight (still requires the $99 dev account) or
  enterprise/ad-hoc distribution.
- The first build after any native change should be smoke-tested: install,
  open, confirm the GRYND page loads and a realtime game connects.
