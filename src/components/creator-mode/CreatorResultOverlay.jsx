"use client";

// src/components/creator-mode/CreatorResultOverlay.jsx
//
// Creator-mode aware wrapper around the shared end-of-match panel
// (<PvpResultScreen />). Every prop is forwarded unchanged, so it is a
// drop-in replacement for the panel itself.
//
// WHY IT EXISTS — two rules every game page has to get right:
//
//   1. MOUNT IT INSIDE <CreatorModeHost>. The recorder captures the
//      provider's frame element, so a win/loss panel rendered as a
//      sibling of the HOST (or inside a node that <CreatorView> swaps
//      out, like a `normal` prop) is not in the recording — the clip
//      ends on the board instead of the result.
//
//        <CreatorModeHost ...>
//          <CreatorView normal={...} portrait={...} landscape={...} />
//          <CreatorResultOverlay open outcome="win" ... />
//        </CreatorModeHost>
//
//   2. LET THE HOST DECIDE THE SIZING. `compact` is the panel's
//      narrow-recording-frame sizing, but the game page builds the panel
//      ABOVE the provider, where useCreatorMode() always reports the
//      default (false) — it cannot tell whether it is recording. This
//      component sits below the host, so it can:
//
//        • creator mode ON  → `compact` panel, sized for the frame the
//          clip is captured at.
//        • creator mode OFF → the full-size desktop panel players see in
//          normal play.
//
// Games that want the panel at one fixed size can keep rendering
// <PvpResultScreen /> directly — this wrapper only adds the conditional.

import React from "react";
import PvpResultScreen from "../result/PvpResultScreen";
import { useCreatorMode } from "../../lib/creator-mode/CreatorModeProvider";

export default function CreatorResultOverlay(props) {
  const { isCreatorMode } = useCreatorMode();
  return <PvpResultScreen {...props} compact={isCreatorMode} />;
}
