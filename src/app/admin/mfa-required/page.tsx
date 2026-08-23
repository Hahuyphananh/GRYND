import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Two-Factor Authentication | GRYND",
  description:
    "Complete two-factor authentication to access the GRYND admin dashboard.",
};

export default function Page() {
  return <PageClient />;
}
