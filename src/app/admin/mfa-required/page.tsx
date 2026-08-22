import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Two-Factor Authentication — GoonBet",
  description:
    "Complete two-factor authentication to access the GoonBet admin dashboard.",
};

export default function Page() {
  return <PageClient />;
}
