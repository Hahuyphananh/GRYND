import { redirect } from "next/navigation";

/**
 * /casino/crash — the classic solo Crash game has been replaced by
 * Crash Arena (PVP). Keep this route alive as a redirect so old
 * bookmarks and links still land on the arena.
 */
export default function CrashRedirectPage() {
  redirect("/casino/crash-arena");
}
