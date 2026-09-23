import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Pool Masters | GRYND",
  description:
    "Play Pool Masters on GRYND. A strategic 1v1 game of pool. Stake tokens, sink the 8-ball and beat your opponent.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
