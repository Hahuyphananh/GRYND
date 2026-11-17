import { redirect } from "next/navigation";

// /casino is the old game hub. GRYND is Solitaire-only now, so the hub has no
// catalogue to show: every visit goes straight to the one game's public page.
// The authenticated lobby itself still lives at /casino/solitaire-duel.

export const metadata = {
  robots: { index: false, follow: true },
};

export default function Page() {
  redirect("/games/solitaire-duel");
}
