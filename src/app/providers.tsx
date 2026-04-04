'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { LanguageProvider } from '../context/LanguageContext';
import { ThemeProvider } from '../context/ThemeContext';
import AppTranslator from '../components/AppTranslator';
import { SocketProvider } from '../context/SocketProvider';

function AppProviders({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null; // or a loader

  return (
    <ThemeProvider>
      <LanguageProvider>
        <SocketProvider>
          <AppTranslator />
          {children}
        </SocketProvider>
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
