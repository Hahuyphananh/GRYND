import type { Metadata } from "next";

import PageClient from "./PageClient";
import { pageMetadata } from "../../lib/seo";

const DAILY_TITLE = "Daily Solitaire Challenge — one deal for everyone";
const DAILY_DESCRIPTION =
  "One deterministic Solitaire deal every UTC day, identical for every GRYND player. Complete it once for an official result and a daily streak; replays are practice.";

export const metadata = pageMetadata({
  title: DAILY_TITLE,
  description: DAILY_DESCRIPTION,
  path: "/daily",
});

export default function Page() {
  return <PageClient />;
}
