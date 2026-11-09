// src/components/solitaire-duel/BotAvatar.tsx
//
// The reusable bot avatar slot.
//
// This version deliberately renders a NEUTRAL PLACEHOLDER: a quiet square with
// the bot's initials and a small robot mark. No generated character art and no
// stock images are bundled. When a local image is ready, set `avatar.src` on the
// bot in `src/lib/solitaire-duel/bots.ts` (for example
// `/images/solitaire-bots/rookie.webp`) and this component renders it instead —
// no page changes required.
//
// The Perfect card uses `perfect` only for its border treatment; the avatar
// itself stays neutral.

import { IconRobot } from "@tabler/icons-react";

import type { SolitaireBot } from "../../lib/solitaire-duel/bots";

export default function BotAvatar({
  bot,
  size = "h-20 w-20",
  perfect = false,
  className = "",
}: {
  bot: Pick<SolitaireBot, "name" | "initials" | "avatar">;
  /** Tailwind size classes. The selection cards use a large square. */
  size?: string;
  perfect?: boolean;
  className?: string;
}) {
  const frame = perfect
    ? "border-amber-300/60 bg-linear-to-br from-amber-300/20 via-[#101a35] to-violet-400/15"
    : "border-white/15 bg-linear-to-br from-white/[0.08] via-[#0a1930] to-black/40";

  if (bot.avatar.src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={bot.avatar.src}
        alt={bot.avatar.alt}
        data-testid="solitaire-bot-avatar-image"
        className={`shrink-0 rounded-xl border object-cover ${frame} ${size} ${className}`}
      />
    );
  }

  return (
    <div
      data-testid="solitaire-bot-avatar-placeholder"
      aria-label={bot.avatar.alt}
      className={`relative flex shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border ${frame} ${size} ${className}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-2 rounded-lg border border-dashed border-white/10"
      />
      <span
        className={`relative font-mono text-xl font-black tracking-[0.16em] ${
          perfect ? "text-amber-200" : "text-cyan-100/80"
        }`}
      >
        {bot.initials}
      </span>
      <IconRobot
        size={12}
        aria-hidden="true"
        className={perfect ? "relative text-amber-200/55" : "relative text-cyan-200/40"}
      />
    </div>
  );
}
