import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Sentry Test Page — GoonBet",
  description: "Internal Sentry error-testing page for the GoonBet Next.js app.",
};

export default function Page() {
  return <PageClient />;
}
