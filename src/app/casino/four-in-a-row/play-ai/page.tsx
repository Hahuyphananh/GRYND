import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Four-In-A-Row vs AI | GRYND",
  description:
    "Play Four-In-A-Row against the AI on GRYND. Sharpen your strategy before facing real players.",
};

export default function Page() {
  return <PageClient />;
}
