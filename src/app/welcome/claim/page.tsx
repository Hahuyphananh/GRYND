import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Keep your progress | GRYND",
  description:
    "Link the practice record from this browser to your GRYND account. Guest matches stay unrated.",
};

export default function Page() {
  return <PageClient />;
}
