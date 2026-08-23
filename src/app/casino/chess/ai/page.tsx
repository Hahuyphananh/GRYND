import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Chess vs AI | GRYND",
  description:
    "Play chess against the AI on GRYND. Choose a difficulty and color and sharpen your strategy before facing real players.",
};

export default function Page() {
  return <PageClient />;
}
