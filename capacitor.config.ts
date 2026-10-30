import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.grynd.app',
  appName: 'GRYND',
  server: {
    // www, not the apex: the apex answers every path with a 308 to www, and a
    // WebView that follows it has already changed origin before the app even
    // boots — so loading www directly is one less hop that can break a POST.
    url: 'https://www.grynd.dedyn.io/',
    cleartext: false,
    // Phase 8: the page the WebView shows when the REMOTE app cannot be loaded.
    // Capacitor's BridgeWebViewClient redirects a failed main-frame load (a
    // network error, or a 4xx/5xx for the main frame) here instead of leaving the
    // platform's blank/white error screen with no way forward. It is a LOCAL
    // asset, served from android/app/src/main/assets/public/, and it is plain
    // HTML with one user-triggered "Try again" that navigates back to the URL
    // above — it has no plugin access, so it cannot touch the session, storage or
    // a live match. `cap sync` leaves that folder alone while server.url is set
    // (copyWebDir only clears it when it is about to copy a webDir).
    errorPath: 'error.html'
  },
  plugins: {
    Keyboard: {
      // Android-only workaround, and only relevant to this app's shape: the
      // Keyboard plugin documents that Android will not resize the WebView when
      // the app is "full screen", which is our case because the Status Bar
      // plugin is installed and Android 15+ draws the app edge-to-edge under
      // the system bars. Without it the IME can sit on top of a focused input
      // (chat composer, a match search field, a report dialog) instead of
      // shortening the page. The `resize` mode itself is iOS-only, so there is
      // nothing else to configure here.
      resizeOnFullScreen: true
    }
  }
};

export default config;
