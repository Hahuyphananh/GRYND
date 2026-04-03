'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { LanguageProvider } from '../context/LanguageContext';
import { ThemeProvider } from '../context/ThemeContext';
import AppTranslator from '../components/AppTranslator';

const FALLBACK_PUBLISHABLE_KEY = 'pk_test_build_fallback';

function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AppTranslator />
        {children}
      </LanguageProvider>
    </ThemeProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || FALLBACK_PUBLISHABLE_KEY;

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <AppProviders>{children}</AppProviders>
    </ClerkProvider>
  );
}
