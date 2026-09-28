import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Tower Arena | GRYND",
  description:
    "Play Tower Arena on GRYND. Competitive head-to-head tower survival. Place blocks, outlast your rival, and claim the prize pool.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}