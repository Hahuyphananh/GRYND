import PageClient from "./PageClient";
import AdSenseScript from "../../components/AdSenseScript";
import AdSlot from "../../components/AdSlot";

export const metadata = {
  title: "My Profile | GRYND",
  description:
    "Manage your GRYND profile. Track your balance, level, titles, streaks and game statistics.",
};

export default function Page() {
  return (
    <>
      {/* The profile is a browsing surface (never a match route), so it may
          carry advertising for free accounts. GRYND PRO members get neither
          the loader nor the slot — this surfaces the very membership they
          might cancel, so the entitlement check matters here. */}
      <AdSenseScript />
      <PageClient adSlot={<AdSlot placement="profile" />} />
    </>
  );
}
