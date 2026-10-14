import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import PageClient from "./PageClient";

// A room is private by definition: its link is shared with the invited players,
// so it is never indexed and never prerendered/shared between users.
export const metadata: Metadata = {
  title: "Private room | GRYND",
  description: "A private GRYND room: invite friends, share the code, start when everyone is in.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * /rooms/[roomId] — the page a shared invite link lands on.
 *
 * The page itself holds no authority: it renders the room's status through
 * `GET /api/rooms/[roomId]`, which answers only the host and the invited guests
 * (`decideViewRoom`). A signed-out visitor gets the sign-in prompt; anybody else
 * who follows a leaked link is told the room is not available to them.
 */
export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { userId } = await auth();
  const { roomId } = await params;

  return <PageClient signedIn={Boolean(userId)} roomId={String(roomId || "")} />;
}
