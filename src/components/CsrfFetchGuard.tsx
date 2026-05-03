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
    const inFlightGetRequests = new Map<string, Promise<Response>>();
    const getResponseCache = new Map<string, { expiresAt: number; response: Response }>();
    const GET_CACHE_TTL_MS = 2000;

    const emitBalanceUpdate = (nextBalance: number) => {
      if (!Number.isFinite(nextBalance)) return;
      window.dispatchEvent(new CustomEvent('balanceUpdated', { detail: { balance: nextBalance } }));
    };

    const extractBalance = (payload: any): number | null => {
      if (!payload || typeof payload !== 'object') return null;

      const candidates = [
        payload?.newBalance,
        payload?.balance,
        payload?.data?.balance,
        payload?.result?.newBalance,
      ];

      for (const value of candidates) {
        const parsed = typeof value === 'string' ? Number(value) : value;
        if (Number.isFinite(parsed)) return Number(parsed);
      }

      return null;
    };

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      const headers = new Headers(init?.headers || {});
      const isMutation = MUTATION_METHODS.has(method);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (method === 'GET' && url.includes('/api/') && !String(init?.cache || '').includes('no-store')) {
        const requestKey = `${method}:${url}`;
        const now = Date.now();
        const cached = getResponseCache.get(requestKey);

        if (cached && cached.expiresAt > now) {
          return cached.response.clone();
        }

        const existing = inFlightGetRequests.get(requestKey);
        if (existing) {
          const sharedResponse = await existing;
          return sharedResponse.clone();
        }

        const sharedRequest = originalFetch(input, {
          ...init,
          headers,
        }).then((res) => {
          if (res.ok) {
            getResponseCache.set(requestKey, { expiresAt: Date.now() + GET_CACHE_TTL_MS, response: res.clone() });
          }
          return res;
        }).finally(() => {
          inFlightGetRequests.delete(requestKey);
        });

        inFlightGetRequests.set(requestKey, sharedRequest);
        const dedupedResponse = await sharedRequest;
        return dedupedResponse.clone();
      }

      if (isMutation) {
        const csrfToken = getCookie('csrf_token');
        if (csrfToken && !headers.has('x-csrf-token')) {
          headers.set('x-csrf-token', csrfToken);
        }
      }

      const response = await originalFetch(input, {
        ...init,
        headers,
      });

      if (url.includes('/api/') && response.ok) {
        try {
          const cloned = response.clone();
          const payload = await cloned.json();
          const balance = extractBalance(payload);
          if (balance !== null) emitBalanceUpdate(balance);
        } catch {
          // Non-JSON responses are ignored.
        }
      }

      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
