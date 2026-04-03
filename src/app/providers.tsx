'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { LanguageProvider } from '../context/LanguageContext';
import { ThemeProvider } from '../context/ThemeContext';
import AppTranslator from '../components/AppTranslator';

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
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const clerkProps = publishableKey ? { publishableKey } : {};

  return (
    <ClerkProvider {...clerkProps}>
      <AppProviders>{children}</AppProviders>
    </ClerkProvider>
  );
}
