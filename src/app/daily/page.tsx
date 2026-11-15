import type { Metadata } from "next";

import PageClient from "./PageClient";

const DAILY_TITLE = "Daily Solitaire Challenge — one deal for everyone";
const DAILY_DESCRIPTION =
  "One deterministic Solitaire deal every UTC day, identical for every GRYND player. Complete it once for an official result and a daily streak; replays are practice.";

export const metadata: Metadata = {
  title: DAILY_TITLE,
  description: DAILY_DESCRIPTION,
  alternates: { canonical: "/daily" },
  openGraph: {
    title: DAILY_TITLE,
    description: DAILY_DESCRIPTION,
    url: "/daily",
    type: "website",
  },
  // The card itself comes from ./opengraph-image.tsx; this only asks platforms
  // for the large format instead of a thumbnail beside the text.
  twitter: {
    card: "summary_large_image",
    title: DAILY_TITLE,
    description: DAILY_DESCRIPTION,
  },
};

export default function Page() {
  return <PageClient />;
}
