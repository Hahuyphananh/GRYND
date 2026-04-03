'use client';

import { useEffect } from 'react';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getCookie(name: string) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default function CsrfFetchGuard() {
  useEffect(() => {
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      const headers = new Headers(init?.headers || {});
      const isMutation = MUTATION_METHODS.has(method);

      if (isMutation) {
        const csrfToken = getCookie('csrf_token');
        if (csrfToken && !headers.has('x-csrf-token')) {
          headers.set('x-csrf-token', csrfToken);
        }
      }

      return originalFetch(input, {
        ...init,
        headers,
      });
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
