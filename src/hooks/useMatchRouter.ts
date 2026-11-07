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
//
// PORTAL SURFACE: while the document is /play/<game>[/<id>], a link to that
// game's own lobby or board is rewritten to the /play mirror first
// (lib/portal/routes). Without that, "Play vs AI" navigated to
// /casino/<game>/<id> — a path a portal frame is not allowed to render — and
// the frame went blank at the first move.

import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  hasAdCodeLoaded,
  resolveMatchNavigation,
} from "../lib/matchNavigation";
import { portalAwareHref } from "../lib/portal/routes";

type AppRouter = ReturnType<typeof useRouter>;
type NavigateOptions = Parameters<AppRouter["push"]>[1];

export function useMatchRouter(): AppRouter {
  const router = useRouter();
  const pathname = usePathname();

  return useMemo(() => {
    const enter = (
      mode: "push" | "replace",
      href: string,
      options?: NavigateOptions,
    ) => {
      // Stay on the framable path when we are already on it.
      const target = portalAwareHref(href, pathname);
      if (resolveMatchNavigation(target, hasAdCodeLoaded()) === "document") {
        if (mode === "replace") window.location.replace(target);
        else window.location.assign(target);
        return;
      }
      if (mode === "replace") router.replace(target, options);
      else router.push(target, options);
    };

    return {
      ...router,
      push: (href: string, options?: NavigateOptions) => enter("push", href, options),
      replace: (href: string, options?: NavigateOptions) =>
        enter("replace", href, options),
    } as AppRouter;
  }, [pathname, router]);
}
