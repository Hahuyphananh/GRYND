// qa/ai-win-daily-reward-harness.jsx
//
// The browser fixture for qa/ai-win-daily-reward-check.mjs. It mounts the REAL
// RPS vs AI practice page and the REAL corner DailyRewardWidget side by side,
// with a scripted backend, so the check can:
//
//   1. play a complete best-of-7 against the bot and win it,
//   2. watch the page report the terminal win to /api/practice/win,
//   3. watch the widget unlock WITHOUT a reload, and
//   4. open the board and claim the reward.
//
// Only the platform chrome and the side effects that need a real browser
// (audio, confetti, presence, Clerk, Next routing) are stubbed by the esbuild
// plugin in the check. The game rules, the result screen and every reward
// component are the shipped ones.

import React from "react";
import { createRoot } from "react-dom/client";
import DailyRewardWidget from "../src/components/DailyRewardWidget";
import RPSPlayAiPage from "../src/app/casino/rps/play-ai/PageClient";

createRoot(document.getElementById("root")).render(
  <>
    <DailyRewardWidget />
    <RPSPlayAiPage />
  </>,
);
