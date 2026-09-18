// src/lib/security/withTimeout.ts
//
// Resolve a promise, or return `fallback` if it doesn't settle within `ms`.
//
// Shared by the page middleware (src/proxy.ts) and the API age gate
// (src/lib/auth/requireAgeVerified.ts). Extracted from proxy.ts so the two
// don't drift apart.

export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
