"use client";

// A page-level Solitaire event, fired once per mount under a stable key.
//
// Page views are actions of the PLAYER (they opened this screen), so they are
// client events. Game results are not fired from here: those belong to the
// server, where the database write proves the result.

import { useEffect } from "react";
import {
  trackSolitaireEventOnce,
  type SolitaireEventName,
  type SolitaireEventProperties,
} from "../../lib/solitaire-analytics";

type Props = {
  event: SolitaireEventName;
  /** Stable identity for the screen; defaults to the event name. */
  keyName?: string;
  properties?: SolitaireEventProperties;
};

export function SolitairePageView({ event, keyName, properties }: Props) {
  useEffect(() => {
    trackSolitaireEventOnce(keyName ?? event, event, properties);
    // Properties are deliberately not a dependency: this is a PAGE view, it
    // fires when the screen opens, not on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, keyName]);

  return null;
}

export default SolitairePageView;
