// src/lib/native/shellServer.ts
//
// The server-component reader for "is this the native app?".
//
// `next/headers` may only be imported by server code, which is why the check
// lives here and not in lib/native/shell.ts — that module is also imported by
// client components (lib/upgradePro.ts), and a `next/headers` import there
// would fail the client build.
//
// Use this from a SERVER COMPONENT (components/AdSenseScript.tsx,
// components/AdSlot.tsx). Route handlers already have the request in hand and
// should call `isNativeShellRequest(request)` from lib/native/shell.ts instead.
//
// Failure policy: FALSE. If the header store is unavailable (not in a request
// scope) we answer "not the app", so the website keeps its ads and checkout.

import { headers } from "next/headers";
import { isNativeShellUserAgent } from "./shell";

/**
 * True when the document being rendered was requested by the GRYND native
 * shell. Reads the User-Agent the shell appends (capacitor.config.ts →
 * `appendUserAgent`).
 */
export async function isNativeShellDocument(): Promise<boolean> {
  try {
    const requestHeaders = await headers();
    return isNativeShellUserAgent(requestHeaders.get("user-agent"));
  } catch {
    return false;
  }
}
