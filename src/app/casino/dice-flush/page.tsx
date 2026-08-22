import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Dice Flush — GoonBet",
  description:
    "Play Dice Flush on GoonBet — roll five dice, lock in combos and outscore your rival in a strategic dice showdown.",
};

export default function Page() {
  return <PageClient />;
}
