import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.app',
  appName: 'create-project',
  server: {
    url: 'https://casino-app-sandy.vercel.app/',
    cleartext: false
  }
};

export default config;