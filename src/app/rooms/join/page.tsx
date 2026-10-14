import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import PageClient from "./PageClient";

// The share link target: private by nature, never indexed.
export const metadata: Metadata = {
  title: "Join a private room | GRYND",
  description: "Join a GRYND private room with the code a friend shared.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * /rooms/join?code=XXXX — the shareable invite link.
 *
 * The code is NOT trusted as an authorization: joining is re-checked on the
 * server (open, unexpired, not a challenge, seat free) and the room is only ever
 * entered by an authenticated account. The link only saves the friend from
 * retyping the code.
 */
export default async function JoinRoomPage() {
  const { userId } = await auth();
  return <PageClient signedIn={Boolean(userId)} />;
}
