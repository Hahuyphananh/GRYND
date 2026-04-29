'use client';

import { useAuth } from '@clerk/nextjs';
import { useEffect } from 'react';

export default function PresenceHeartbeat() {
  const { isSignedIn, isLoaded } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    const ping = () => {
      fetch('/api/presence/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        keepalive: true,
        body: '{}' 
      }).catch((error) => {
        console.error('[PRESENCE_HEARTBEAT_CLIENT_ERROR]', error);
      });
    };

    ping();
    const interval = setInterval(ping, 20000);
    return () => clearInterval(interval);
  }, [isLoaded, isSignedIn]);

  return null;
}
