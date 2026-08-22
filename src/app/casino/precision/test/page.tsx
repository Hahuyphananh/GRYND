import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Precision Practice — GoonBet",
  description:
    "Sharpen your Precision reaction-time skills on GoonBet with a free practice mode before you wager.",
};

export default function Page() {
  return <PageClient />;
}
