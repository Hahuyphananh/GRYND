import type { Metadata } from "next";

import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Daily Solitaire Challenge — one deal for everyone",
  description:
    "One deterministic Solitaire deal every UTC day, identical for every GRYND player. Complete it once for an official result and a daily streak; replays are practice.",
  alternates: { canonical: "/daily" },
};

export default function Page() {
  return <PageClient />;
}
