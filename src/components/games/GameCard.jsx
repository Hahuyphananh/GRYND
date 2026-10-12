"use client";

import Image from "next/image";
import Link from "next/link";
import FrameAvatar from "../FrameAvatar";
import { useTranslation } from "../../hooks/useTranslation";

/**
 * THE game card — the single card element in the product.
 *
 * ── Why this is a shared component ────────────────────────────────────────
 *
 * This markup used to live inside src/app/casino/PageClient.jsx, so only the
 * lobby could draw a game card. The FAQ's games directory (/faq) now renders
 * the SAME card for every game, so the markup moved here and both surfaces
 * import it. Two card systems drawing the same game differently is the thing
 * this prevents, and tests assert there is exactly ONE definition of it in the
 * repo (tests/lobby-for-you.test.mjs, tests/game-presence.test.mjs).
 *
 * ── What the caller supplies ──────────────────────────────────────────────
 *
 *   game          the card's own data. `title` / `description` are the two
 *                 accepted shapes: a resolved string (the FAQ passes the
 *                 catalogue's name + meta description) or an i18n pair
 *                 (`nameKey` / `descriptionKey`, which the lobby passes and
 *                 which this component translates).
 *   recommended   the "For You" marker. Opt-in, so an ordinary card is
 *                 unchanged by its existence.
 *   isNewest      the recency pill. Passed in rather than derived, because
 *                 "newest" is a property of the lobby's catalogue ordering.
 *   presence      a lobby-only ReactNode (the live "N playing" badge). The FAQ
 *                 passes nothing: it fetches no presence data, and an absent
 *                 slot renders an empty layout, not a zero.
 *   friends       lobby-only friend-presence avatars.
 *
 * Everything else — the artwork, the PvP pill, the title, the blurb, the CTA
 * and the leaderboard link — is identical wherever the card is rendered.
 *
 * The whole card is a real anchor (`<Link href={game.href}>`), which is what
 * makes both surfaces crawlable; the footer deliberately sits OUTSIDE that
 * link so its "N playing" count is not swallowed by the anchor's aria-label.
 */
export default function GameCard({
  game,
  recommended = false,
  isNewest = false,
  presence = null,
  friends = null,
}) {
  const { t } = useTranslation();
  const title = game.title ?? (game.nameKey ? t(game.nameKey) : game.name);
  const description = game.description ?? t(game.descriptionKey);

  return (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:scale-[1.02] hover:border-[#00e5ff]/60 hover:shadow-[0_0_30px_rgba(0,229,255,0.4)] focus-within:ring-2 focus-within:ring-[#00e5ff] focus-within:ring-offset-2 focus-within:ring-offset-[#040d24]">
      <Link
        href={game.href}
        className="block cursor-pointer focus-visible:outline-none"
        aria-label={`Play ${title}`}
      >
        <div className="mb-3 relative aspect-video overflow-hidden rounded-lg">
          <Image
            src={game.image}
            alt={title}
            quality={85}
            loading="lazy"
            // Source art is 1.6–2.4MB PNGs — the card only ever displays
            // at ~3–4 columns wide, so let the optimizer serve a
            // viewport-sized variant instead of the full-res original.
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
            className={`h-full w-full object-cover object-center transition-transform group-hover:scale-110 ${game.imageClassName || ""}`}
          />
          {/* PvP badge — real product data: every GRYND game is a competitive
              1v1 duel (the shared multiplayer tables were retired). */}
          <span className="absolute left-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.45)] backdrop-blur-sm">
            {t("home.pvp_badge")}
          </span>
          {/* Popular / New badges — brand neon pills over the card art.
              Purely informational chrome: aria-hidden so screen readers
              don't double-announce what the game title already says. */}
          {/* NEW takes priority: the newest games always carry the recency
              badge even when they're also popular, so the recency signal is
              unambiguous (popularity stays discoverable via the filter). */}
          {isNewest && (
            <span
              aria-hidden="true"
              className="absolute right-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.45)] backdrop-blur-sm"
            >
              {t("home.casino_lobby.badge_new")}
            </span>
          )}
          {game.popular && !isNewest && (
            <span
              aria-hidden="true"
              className="absolute right-2 top-2 rounded-full border border-[#f5ff3b]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#f5ff3b] shadow-[0_0_10px_rgba(245,255,59,0.45)] backdrop-blur-sm"
            >
              {t("home.casino_lobby.badge_hot")}
            </span>
          )}
          {/* "For You" only: a quiet marker on a personal pick. Anchored to
              the image's bottom-right so it never fights the PvP badge
              (top-left) or the NEW/HOT pills (top-right). */}
          {recommended && (
            <span className="absolute bottom-2 right-2 rounded-full border border-[#f0abfc]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#f0abfc] shadow-[0_0_10px_rgba(240,171,252,0.4)] backdrop-blur-sm">
              {t("home.casino_lobby.recommended_badge")}
            </span>
          )}
        </div>

        <h3 className="mb-2 text-lg font-extrabold tracking-tight text-[#f5ff3b] md:text-xl">
          {title}
        </h3>

        <p className="line-clamp-2 text-sm leading-relaxed text-[#9dd8ff] md:text-[15px]">
          {description}
        </p>

        {/* Primary CTA — always visible, works on touch. The whole card is
            a link; this makes the action explicit without hover. */}
        <div className="mt-4">
          <span className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-2 text-sm font-bold text-[#00e5ff] transition-all duration-200 group-hover:bg-[#00e5ff] group-hover:text-black group-hover:shadow-[0_0_15px_rgba(0,229,255,0.5)] sm:w-auto">
            {t("home.casino_lobby.play")}
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </span>
        </div>
      </Link>
      {/* Card footer: live activity first, then the leaderboard shortcut.
          The count deliberately sits OUTSIDE the card's Link — that link has
          its own aria-label ("Play <game>"), which would otherwise swallow the
          count for screen readers — and adding it here leaves the title,
          description, CTA and the art badges (PvP / NEW / HOT / Recommended /
          friends) untouched. */}
      <div className="mt-auto pt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {presence}
        <Link
          href={`/classement?game=${game.leaderboardKey}`}
          className="text-xs text-[#00e5ff] underline underline-offset-2 hover:text-[#d8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24] rounded"
        >
          {t("home.view_leaderboard")} {title}
        </Link>
      </div>

      {Array.isArray(friends) && friends.length > 0 && (
        <div
          className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1"
          title={friends.map((f) => f.name).join(", ")}
        >
          {friends.slice(0, 4).map((friend) => (
            <FrameAvatar
              key={`${friend.id}-${friend.name}`}
              frame={friend.profileFrame}
              iconKey={friend.iconKey}
              name={friend.name}
              size="h-6 w-6"
              className="border border-white/30"
            />
          ))}
        </div>
      )}
    </div>
  );
}
