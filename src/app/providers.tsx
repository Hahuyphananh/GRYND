'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';
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

  if (!publishableKey) {
    return <AppProviders>{children}</AppProviders>;
  }

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <AppProviders>{children}</AppProviders>
    </ClerkProvider>
  );
}
