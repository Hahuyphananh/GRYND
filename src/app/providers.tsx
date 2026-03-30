'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { LanguageProvider } from '../context/LanguageContext';
import { ThemeProvider } from '../context/ThemeContext';
import AppTranslator from '../components/AppTranslator';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <ThemeProvider>
        <LanguageProvider>
          <AppTranslator />
          {children}
        </LanguageProvider>
      </ThemeProvider>
    </ClerkProvider>
  );
}
