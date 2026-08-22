import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Account Sync — GoonBet",
  description:
    "Syncing your GoonBet account. Please wait while we link your profile and balance.",
};

export default function Page() {
  return <PageClient />;
}
