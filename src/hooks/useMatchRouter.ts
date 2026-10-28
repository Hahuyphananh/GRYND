"use client";

// src/hooks/useMatchRouter.ts
//
// The router a game lobby uses. It is next/navigation's router for every
// destination EXCEPT a match: when the current document has loaded ad code
// (lib/matchNavigation.ts), entering a match is a document navigation, so the
// lobby's AdSense loader cannot keep running over
// the board. Everything else — and every entry from a document without ad code,
// such as a GRYND PRO member's — stays a normal client-side navigation.
//
// Call sites keep reading `router.push(...)` / `router.replace(...)`, and the
// decision is made on the RESOLVED href, so template-built match URLs
// (`matchPath(id)`, `matchHref(id)`) are covered too.

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  hasAdCodeLoaded,
  resolveMatchNavigation,
} from "../lib/matchNavigation";

type AppRouter = ReturnType<typeof useRouter>;
type NavigateOptions = Parameters<AppRouter["push"]>[1];

export function useMatchRouter(): AppRouter {
  const router = useRouter();

  return useMemo(() => {
    const enter = (
      mode: "push" | "replace",
      href: string,
      options?: NavigateOptions,
    ) => {
      if (resolveMatchNavigation(href, hasAdCodeLoaded()) === "document") {
        if (mode === "replace") window.location.replace(href);
        else window.location.assign(href);
        return;
      }
      if (mode === "replace") router.replace(href, options);
      else router.push(href, options);
    };

    return {
      ...router,
      push: (href: string, options?: NavigateOptions) => enter("push", href, options),
      replace: (href: string, options?: NavigateOptions) =>
        enter("replace", href, options),
    } as AppRouter;
  }, [router]);
}
