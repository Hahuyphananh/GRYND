import PageClient from "./PageClient";
import AdSenseScript from "../../components/AdSenseScript";
import AdSlot from "../../components/AdSlot";

export const metadata = {
  title: "Battlepass | GRYND",
  description:
    "Climb the GRYND Battlepass. Win ranked matches to earn trophies and level up through 100 levels, unlocking name glows, emotes, profile frames and titles.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient adSlot={<AdSlot placement="battlepass" />} />
    </>
  );
}
