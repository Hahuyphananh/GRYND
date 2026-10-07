import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },

  title: "Sentry Test Page | GRYND",
  description: "Internal Sentry error-testing page for the GRYND Next.js app.",
};

export default function Page() {
  return <PageClient />;
}
