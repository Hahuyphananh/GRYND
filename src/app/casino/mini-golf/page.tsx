import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Mini Golf | GRYND",
  description:
    "Play Mini Golf on GRYND. Best of 5 holes, first to 3 hole wins — a free 1v1 ranked duel against another player.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
