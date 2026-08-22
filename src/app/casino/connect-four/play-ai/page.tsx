import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Connect Four vs AI — GoonBet",
  description:
    "Play Connect Four against the AI on GoonBet — sharpen your strategy before facing real players.",
};

export default function Page() {
  return <PageClient />;
}
