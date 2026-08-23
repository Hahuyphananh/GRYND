import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Connect Four vs AI | GRYND",
  description:
    "Play Connect Four against the AI on GRYND. Sharpen your strategy before facing real players.",
};

export default function Page() {
  return <PageClient />;
}
