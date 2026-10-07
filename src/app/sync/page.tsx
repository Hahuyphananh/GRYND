import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },

  title: "Account Sync | GRYND",
  description:
    "Syncing your GRYND account. Please wait while we link your profile and balance.",
};

export default function Page() {
  return <PageClient />;
}
