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
  const pathname = usePathname();
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const isStaticErrorPage = pathname === '/_not-found' || pathname === '/404';

  if (!publishableKey || isStaticErrorPage) {
    return <AppProviders>{children}</AppProviders>;
  }

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <AppProviders>{children}</AppProviders>
    </ClerkProvider>
  );
}
