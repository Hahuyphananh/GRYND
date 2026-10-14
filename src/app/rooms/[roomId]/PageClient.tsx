"use client";

// src/app/rooms/[roomId]/PageClient.tsx
//
// The room page: GRYND's standard chrome around the room the link points to.
//
// A signed-out visitor is asked to sign in first — the room API is
// authenticated, and an invitation is addressed to an account, not to a browser.

import Link from "next/link";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import InteractiveCasinoBg from "../../../components/InteractiveCasinoBg";
import RoomsPanel from "../../../components/rooms/RoomsPanel";
import { useTranslation } from "../../../hooks/useTranslation";

export default function RoomPageClient({
  signedIn,
  roomId,
}: {
  signedIn: boolean;
  roomId: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />
      <NavigationBar currentPath="/rooms" />

      <main className="relative mx-auto w-full max-w-5xl px-4 pb-16 pt-24 sm:px-6">
        <h1 className="text-2xl font-black text-white sm:text-3xl">
          {t("rooms.pageTitle", "Private room")}
        </h1>

        {signedIn ? (
          <RoomsPanel focusRoomId={roomId} className="mt-6" />
        ) : (
          <div className="mt-6 rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6">
            <p className="text-sm text-gray-200">
              {t("rooms.signInToView", "Sign in to see this room and join it.")}
            </p>
            <Link
              href="/sign-in"
              className="mt-3 inline-block rounded bg-[#00e5ff] px-4 py-2 text-sm font-semibold text-[#003366]"
            >
              {t("rooms.signIn", "Sign in")}
            </Link>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
