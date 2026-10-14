"use client";

// src/app/rooms/join/PageClient.tsx
//
// The invite-link landing page: takes the `?code=` a host shared, joins the
// room once (through the authenticated API), and shows the outcome — success
// with a link to the room, or the server's reason (expired, full, cancelled,
// wrong code). A signed-out visitor is asked to sign in first.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import InteractiveCasinoBg from "../../../components/InteractiveCasinoBg";
import { useTranslation } from "../../../hooks/useTranslation";
import { useRooms } from "../../../hooks/useRooms";

export default function JoinRoomPageClient({ signedIn }: { signedIn: boolean }) {
  const { t } = useTranslation();
  const rooms = useRooms({ enabled: false });
  const [code, setCode] = useState("");
  const [joinedRoomId, setJoinedRoomId] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);

  // Auto-join once for a link that carries a code. `attempted` keeps a re-render
  // (or a StrictMode double-mount) from submitting a second join.
  useEffect(() => {
    if (!signedIn || attempted.current) return;
    const fromUrl = new URLSearchParams(window.location.search).get("code") || "";
    const normalized = fromUrl.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!normalized) return;
    attempted.current = true;
    setCode(normalized);
    void (async () => {
      setBusy(true);
      const result = await rooms.joinByCode(normalized);
      setBusy(false);
      if (result.ok) {
        const room = rooms.rooms.find((item) => item.code === normalized);
        setJoinedRoomId(room?.id || "");
        return;
      }
      setErrorCode(result.code);
      setErrorMessage(result.message);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  const submit = async () => {
    const normalized = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!normalized) return;
    setBusy(true);
    setErrorCode("");
    setErrorMessage("");
    const result = await rooms.joinByCode(normalized);
    setBusy(false);
    if (result.ok) {
      const room = rooms.rooms.find((item) => item.code === normalized);
      setJoinedRoomId(room?.id || "");
      return;
    }
    setErrorCode(result.code);
    setErrorMessage(result.message);
  };

  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />
      <NavigationBar currentPath="/rooms" />

      <main className="relative mx-auto w-full max-w-2xl px-4 pb-16 pt-24 sm:px-6">
        <h1 className="text-2xl font-black text-white sm:text-3xl">
          {t("rooms.joinTitle", "Join a private room")}
        </h1>
        <p className="mt-2 text-sm text-[#9dd8ff]/80">
          {t("rooms.joinHint", "Enter the room code a friend shared with you.")}
        </p>

        {!signedIn ? (
          <div className="mt-6 rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6">
            <p className="text-sm text-gray-200">
              {t("rooms.signInToJoin", "Sign in to join this room.")}
            </p>
            <Link
              href="/sign-in"
              className="mt-3 inline-block rounded bg-[#00e5ff] px-4 py-2 text-sm font-semibold text-[#003366]"
            >
              {t("rooms.signIn", "Sign in")}
            </Link>
          </div>
        ) : (
          <div className="mt-6 rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6">
            <label htmlFor="join-code" className="text-xs font-semibold uppercase tracking-wide text-gray-300">
              {t("rooms.joinCodeLabel", "Room code")}
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                id="join-code"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                maxLength={16}
                className="w-48 rounded border border-white/20 bg-[#08203f] px-3 py-2 font-mono text-sm tracking-widest text-white"
              />
              <button
                type="button"
                onClick={submit}
                disabled={busy || !code.trim()}
                className="rounded bg-[#00e5ff] px-4 py-2 text-sm font-semibold text-[#003366] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                {busy ? t("rooms.joining", "Joining…") : t("rooms.join", "Join")}
              </button>
            </div>

            {joinedRoomId && (
              <p className="mt-4 text-sm text-emerald-200">
                {t("rooms.joined", "You are in.")}{" "}
                <Link
                  href={`/rooms/${joinedRoomId}`}
                  className="font-semibold text-[#00e5ff] underline"
                >
                  {t("rooms.openRoom", "Open the room")}
                </Link>
              </p>
            )}

            {errorCode && (
              <p className="mt-4 rounded border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {t(`rooms.error_${errorCode}`, errorMessage || t("rooms.joinFailed", "Could not join that room."))}
              </p>
            )}

            {!joinedRoomId && !errorCode && (
              <p className="mt-4 text-xs text-gray-300">
                {t(
                  "rooms.joinFallback",
                  "If the room is full, expired or already closed, you will be told why.",
                )}
              </p>
            )}
          </div>
        )}

        <p className="mt-6 text-sm text-gray-300">
          <Link href="/profil" className="font-semibold text-[#00e5ff] underline">
            {t("rooms.backToFriends", "Back to your friends")}
          </Link>
        </p>
      </main>

      <Footer />
    </div>
  );
}
