import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Precision | GRYND",
  description:
    "Play Precision on GRYND. Wager tokens and face another player in a 1v1 reaction-time duel. Test your reflexes and win the pot.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
