"use client";

import { useEffect, useState } from "react";

/**
 * The FAQ's "on this page" navigation — it tells the reader which section they
 * are currently in, and every entry is a real anchor.
 *
 * ── Why a client component ────────────────────────────────────────────────
 *
 * Knowing which section the reader is looking at needs scroll position, so this
 * is the one part of /faq that must run in the browser. It receives plain
 * `[{ id, label }]` data from the server page and renders nothing else: the
 * FAQ's answers stay server-rendered, and every entry is an `<a href="#…">` that
 * works with no JavaScript at all (with JS off the page simply never highlights
 * anything, which is the honest degradation).
 *
 * ── Two shapes, one state ─────────────────────────────────────────────────
 *
 *   FaqSidebarRail   < lg   a chip rail that sticks under the fixed navbar,
 *                           placed directly in the page container so it can
 *                           stay stuck for the whole page.
 *   FaqSidebarList   >= lg  a vertical list in its own grid column, stuck below
 *                           the navbar. Its grid cell stretches to the content
 *                           column's height, which is what gives `sticky` room
 *                           to move.
 *
 * They are separate elements because a sticky element only sticks while its
 * PARENT is on screen: a single element containing both would be stuck inside a
 * parent exactly as tall as itself. Both call the same hook, so the active
 * section is computed once per shape by identical rules.
 *
 * ── How "current" is decided ──────────────────────────────────────────────
 *
 * The active entry is the LAST section whose heading has passed the reading
 * line — a line placed just below the fixed navbar, where an anchor jump lands
 * (`scroll-mt-28` = 112px on every section). So the highlight always names the
 * heading the reader scrolled past, and a section's own entry is still current
 * immediately after the reader clicks it.
 *
 * The rule is deliberately a plain measurement rather than an
 * IntersectionObserver band: these sections are long and stack edge to edge, so
 * any band they cross can contain two of them at once, and picking the wrong one
 * of the two is exactly what a contents list must not do. "Last heading above
 * the line" has one answer at every scroll position.
 *
 * One extra rule: at the bottom of the page the last entry is the honest answer
 * even when the final heading has not quite reached the line.
 */
const READING_LINE = 152;

/** Which section id is currently the reader's place in the page. */
function useActiveSection(items) {
  const [activeId, setActiveId] = useState(items[0]?.id ?? "");

  useEffect(() => {
    if (items.length === 0) return undefined;

    let frame = 0;

    const measure = () => {
      frame = 0;
      let current = items[0].id;
      for (const item of items) {
        const element = document.getElementById(item.id);
        if (element && element.getBoundingClientRect().top <= READING_LINE) {
          current = item.id;
        }
      }
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 2;
      setActiveId(atBottom ? items[items.length - 1].id : current);
    };

    // Read on the next frame at most: a scroll burst must not queue a layout
    // read per event.
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [items]);

  return [activeId, setActiveId];
}

/**
 * The narrow-viewport rail. Sticky, so the current section stays visible while
 * the reader scrolls the answers; it scrolls horizontally when the labels do not
 * fit, which is what keeps eight long section names usable on a 360px screen.
 */
export function FaqSidebarRail({ items = [] }) {
  const [activeId, setActiveId] = useActiveSection(items);
  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Sections of this page"
      className="sticky top-16 z-30 mb-6 border-y border-[#00e5ff]/15 bg-[#030817]/95 py-2 backdrop-blur-md lg:hidden"
    >
      <ul className="flex gap-2 overflow-x-auto pb-0.5">
        {items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <li key={item.id} className="shrink-0">
              <a
                href={`#${item.id}`}
                onClick={() => setActiveId(item.id)}
                aria-current={isActive ? "true" : undefined}
                className={`block whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  isActive
                    ? "border-[#f5ff3b]/70 bg-[#f5ff3b]/15 text-[#f5ff3b]"
                    : "border-[#00e5ff]/25 text-[#9dd8ff] hover:border-[#00e5ff]/50 hover:text-[#d8fbff]"
                }`}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The wide-viewport contents list, in its own column. */
export function FaqSidebarList({ items = [] }) {
  const [activeId, setActiveId] = useActiveSection(items);
  if (items.length === 0) return null;

  return (
    <nav aria-label="Sections of this page" className="hidden lg:block" data-testid="faq-sidebar">
      <div className="sticky top-28">
        <p className="mb-3 text-[11px] font-black uppercase tracking-[0.22em] text-[#9dd8ff]">
          On this page
        </p>
        <ul className="space-y-1 border-l border-[#00e5ff]/20">
          {items.map((item) => {
            const isActive = item.id === activeId;
            return (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  onClick={() => setActiveId(item.id)}
                  aria-current={isActive ? "true" : undefined}
                  className={`-ml-px block border-l-2 py-1.5 pl-3 text-sm leading-snug transition ${
                    isActive
                      ? "border-[#f5ff3b] font-semibold text-[#f5ff3b]"
                      : "border-transparent text-[#9dd8ff] hover:border-[#00e5ff]/60 hover:text-[#d8fbff]"
                  }`}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
