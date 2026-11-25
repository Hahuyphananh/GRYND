// qa/solitaire-bot-result-harness.tsx
//
// Mounts the REAL practice result popup — the shared `PvpResultScreen` with the
// same props the Solitaire Duel match page passes for a bot — so the visual
// check can screenshot and measure the win and loss layouts without a server,
// database, Clerk session or a finished match.
//
// The portrait, name, rating label and ending dialog are the shipped ones:
// `bots.ts` artwork, `PvpResultScreen`'s AI hero, and `BotSpeech` resolving the
// bot's own line from `solitaireResultLine`.

import React from "react";
import { createRoot } from "react-dom/client";

import PvpResultScreen from "../src/components/result/PvpResultScreen";
import BotSpeech from "../src/components/solitaire-duel/BotSpeech";
import { SOLITAIRE_BOT_BY_ID } from "../src/lib/solitaire-duel/bots";
import { solitaireResultLine } from "../src/lib/solitaire-duel/dialogueDirector";

const bot = SOLITAIRE_BOT_BY_ID.rookie;
const MATCH_ID = "practice-preview-1";

function PracticeResult({ outcome }: { outcome: "win" | "loss" }) {
  // The bot won exactly when the viewer lost — the same mapping the match page
  // uses, so the dialog matches the outcome.
  const line = solitaireResultLine({
    botId: bot.id,
    matchId: MATCH_ID,
    botWon: outcome === "loss",
  });

  return (
    <PvpResultScreen
      open
      revealDelayMs={0}
      outcome={outcome}
      headline={outcome === "win" ? "You solved it first." : `${bot.name} took the duel`}
      subline="Practice match against a Solitaire bot."
      opponent={{
        name: bot.name,
        iconKey: null,
        profileFrame: null,
        isAi: true,
        imageSrc: bot.avatar.src,
        imageAlt: bot.avatar.alt,
        ratingLabel: bot.ratingLabel,
      }}
      gameName="Solitaire Duel"
      gameKey="solitaire-duel"
      showGlitch={false}
      extraContent={
        <BotSpeech
          bot={bot}
          line={line}
          showAvatar={false}
          testId="solitaire-bot-result-speech"
        />
      }
      durationSeconds={96}
      sides={[
        { name: "You", score: outcome === "win" ? "52/52" : "31/52", highlight: outcome === "win" },
        { name: bot.name, score: outcome === "win" ? "38/52" : "52/52", highlight: outcome === "loss" },
      ]}
      summary={[
        { label: "Your foundations", value: outcome === "win" ? "52/52" : "31/52" },
        { label: "Opponent foundations", value: outcome === "win" ? "38/52" : "52/52" },
      ]}
      playAgain={{ label: "NEW DEAL", onClick: () => {} }}
      secondaryAction={{ label: "Back to home", href: "/" }}
      onReturnToLobby={() => {}}
    />
  );
}

let root: ReturnType<typeof createRoot> | null = null;

(window as unknown as {
  __botResult: { mount: (outcome: "win" | "loss") => void };
}).__botResult = {
  mount(outcome) {
    const host = document.getElementById("root");
    if (!host) return;
    if (!root) root = createRoot(host);
    root.render(<PracticeResult outcome={outcome} />);
  },
};
