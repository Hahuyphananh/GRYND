import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Tower Arena | GRYND",
  description:
    "Play Tower Arena on GRYND. Competitive shared-tower survival for 2–6 players. Place blocks, outlast your rivals, and claim the prize pool.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}