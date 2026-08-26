import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.grynd.app',
  appName: 'GRYND',
  server: {
    url: 'https://www.grynd.mywire.org/',
    cleartext: false
  }
};

export default config;
