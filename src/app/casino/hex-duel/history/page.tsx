import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Hex Duel History | GRYND",
  description: "Review your Hex Duel match history on GRYND.",
};

export default function Page() {
  return <PageClient />;
}
