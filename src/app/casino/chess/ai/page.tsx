import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Chess vs AI — GRYND",
  description:
    "Play chess against the AI on GRYND — choose a difficulty and color and sharpen your strategy before facing real players.",
};

export default function Page() {
  return <PageClient />;
}
