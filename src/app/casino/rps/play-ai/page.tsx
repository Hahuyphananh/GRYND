import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Rock-Paper-Scissors vs AI | GRYND",
  description:
    "Play Rock-Paper-Scissors against the AI on GRYND. Practice your reads before facing real opponents.",
};

export default function Page() {
  return <PageClient />;
}
