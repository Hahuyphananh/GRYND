import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Precision Practice — GRYND",
  description:
    "Sharpen your Precision reaction-time skills on GRYND with a free practice mode before you wager.",
};

export default function Page() {
  return <PageClient />;
}
