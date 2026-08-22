import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Memory Grid — GRYND",
  description:
    "Play Memory Grid on GRYND — stake tokens and race another player on a shared 4×4 grid. Flip two cards to match pairs, winner takes 1.9×.",
  openGraph: { images: [ogImageUrl("/images/og/memory-grid.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
