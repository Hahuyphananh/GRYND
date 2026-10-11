import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.grynd.app',
  appName: 'GRYND',
  server: {
    // www, not the apex: the apex answers every path with a 308 to www, and a
    // WebView that follows it has already changed origin before the app even
    // boots — so loading www directly is one less hop that can break a POST.
    url: 'https://www.grynd.dedyn.io/',
    cleartext: false
  }
};

export default config;
