import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Dice Flush | GRYND",
  description:
    "Play Dice Flush on GRYND. Roll five dice, lock in combos and outscore your rival in a strategic dice showdown.",
};

export default function Page() {
  return <PageClient />;
}
