import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Precision Practice | GRYND",
  description:
    "Sharpen your Precision reaction-time skills on GRYND in free practice — no wager, nothing at risk.",
};

export default function Page() {
  return <PageClient />;
}
