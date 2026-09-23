import PageClient from "./PageClient";
import AdSenseScript from "../../components/AdSenseScript";

export const metadata = {
  title: "Battlepass | GRYND",
  description:
    "Climb the GRYND Battlepass. Earn XP by wagering tokens and completing daily and weekly quests to level up through 100 levels.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
