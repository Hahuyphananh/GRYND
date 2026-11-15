"use client";

// Trustpilot TrustBox.
//
// Trustpilot ships a widget as two pieces: a bootstrap script that defines
// window.Trustpilot, and a `.trustpilot-widget` element it turns into an
// iframe in place. Neither piece can be pasted in as a static <script> here:
// this is a single-page app, so a widget mounted after a client-side
// navigation would never be picked up, and the bootstrap must be loaded at most
// once per document however many widgets a page renders.
//
// So this component:
//   1. injects the bootstrap once, tagged with a fixed id (a second widget on
//      the same page finds the existing tag instead of adding another),
//   2. calls window.Trustpilot.loadFromElement() once it is available — on this
//      mount, or in the script's load handler when this is the first widget,
//   3. mirrors the page's theme onto the widget and reloads it when the
//      light/dark switch flips, because the TrustBox reads data-theme only
//      while it initialises.
//
// It renders nothing of its own to decide: the parent only mounts it when the
// deploy has a real business unit id and template id (src/lib/trustpilot.ts).

import { useEffect, useRef } from "react";
import { TRUSTPILOT_SCRIPT_SRC } from "../../lib/trustpilot";

const SCRIPT_ID = "trustpilot-trustbox-bootstrap";

declare global {
  interface Window {
    Trustpilot?: {
      loadFromElement?: (element: HTMLElement | null, force?: boolean) => void;
    };
  }
}

type TrustpilotWidgetProps = {
  businessUnitId: string;
  templateId: string;
  /** Review domain, only used for the no-JavaScript fallback link. */
  domain: string;
  locale?: string;
  /** TrustBox height, as the widget expects it ("90px", "240px"...). */
  height?: string;
};

export default function TrustpilotWidget({
  businessUnitId,
  templateId,
  domain,
  locale = "en-US",
  height = "140px",
}: TrustpilotWidgetProps) {
  const widgetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = widgetRef.current;
    if (!element) return;

    let disposed = false;

    // The page's theme lives on <html data-theme>, set before first paint by
    // the bootstrap in src/app/layout.tsx (see src/context/ThemeContext.js).
    const pageTheme = () =>
      document.documentElement.getAttribute("data-theme") === "light"
        ? "light"
        : "dark";

    const load = () => {
      if (disposed) return;
      const theme = pageTheme();
      if (element.getAttribute("data-theme") !== theme) {
        element.setAttribute("data-theme", theme);
      }
      // force = true, so a re-load (theme change, remount) replaces the iframe
      // instead of being skipped as already initialised.
      window.Trustpilot?.loadFromElement?.(element, true);
    };

    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = TRUSTPILOT_SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }

    if (window.Trustpilot) {
      load();
    } else {
      script.addEventListener("load", load);
    }

    const observer = new MutationObserver(() => {
      if (element.getAttribute("data-theme") !== pageTheme()) load();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      disposed = true;
      script?.removeEventListener("load", load);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={widgetRef}
      className="trustpilot-widget"
      data-locale={locale}
      data-template-id={templateId}
      data-businessunit-id={businessUnitId}
      data-style-height={height}
      data-style-width="100%"
      data-theme="dark"
    >
      {/* What a visitor without JavaScript still gets: a link to the profile. */}
      <a
        href={`https://www.trustpilot.com/review/${domain}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Trustpilot
      </a>
    </div>
  );
}
