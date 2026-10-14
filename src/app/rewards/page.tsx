import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  alternates: { canonical: "/rewards" },
  title: "Rewards | GRYND",
  description:
    "Your next achievement could unlock something more. Gift-card rewards are coming to GRYND — see what is on the way. Coins are virtual and have no cash value.",
};

/**
 * The Rewards surface (/rewards).
 *
 * Publicly reachable — the page itself holds nothing account-specific. The
 * caller's coin balance is read on the client from the EXISTING coin system
 * (the shared useCoinBalance hook, which reads /api/get-user-tokens); this page
 * neither owns nor writes any currency. When a visitor is signed out the page
 * still renders in full and simply prompts them to sign in to see their coins.
 */
export default function Page() {
  return <PageClient />;
}
