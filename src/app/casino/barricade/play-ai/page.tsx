import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Barricade vs AI | GRYND",
  description:
    "Play Barricade free against the AI on GRYND. Race your pawn across the 9×9 board, drop barricades to slow your opponent down, and practise before facing real players.",
};

export default function Page() {
  return <PageClient />;
}
