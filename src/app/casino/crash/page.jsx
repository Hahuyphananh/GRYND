import { redirect } from "next/navigation";

/**
 * /casino/crash — the classic solo Crash game has been replaced by
 * Crash Arena (PVP). Keep this route alive as a redirect so old
 * bookmarks and links still land on the arena.
 */
export const metadata = {
  title: "Crash — GRYND",
  description:
    "The classic Crash game is now Crash Arena on GRYND — join a table, survive the crash and claim the pot.",
};

export default function CrashRedirectPage() {
  redirect("/casino/crash-arena");
}
