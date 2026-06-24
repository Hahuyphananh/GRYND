"use client";

// ── Casino-grid entry wrapper for the Precision game ────────────────────
//
// Mirrors PoolMastersClient.tsx so the casino can link into the game
// without the underlying lobby page having to mount on the casino index.

import { useRouter } from "next/navigation";
import NavigationBar from "../navigation-bar";
import { usePostHog } from "posthog-js/react";
import { useEffect } from "react";
import { useTranslation } from "../../hooks/useTranslation";

export default function PrecisionLobbyClient() {
  const router = useRouter();
  const posthog = usePostHog();
  const { t } = useTranslation();

  useEffect(() => {
    posthog?.capture("precision_lobby_viewed");
  }, []);

  return (
    <div className="mx-auto max-w-5xl rounded-2xl border border-cyan-400/40 bg-black/30 p-6 shadow-[0_0_30px_rgba(34,211,238,.25)]">
      <NavigationBar currentPath="/casino" />
      <h2 className="mt-3 text-4xl font-black text-fuchsia-300">{t("games.precision.lobby_title")}</h2>
      <p className="mt-2 text-cyan-100">
        {t("games.precision.lobby_subtitle")}
      </p>
      <div className="mt-6 rounded-xl border border-cyan-500/40 bg-[#02141a] p-5">
        <h3 className="text-xl font-bold">{t("games.precision.lobby_panel_title")}</h3>
        <p className="mt-1 text-sm text-cyan-100/90">
          {t("games.precision.lobby_panel_desc")}
        </p>
        <button
          onClick={() => router.push("/casino/precision")}
          className="mt-4 rounded bg-fuchsia-500 px-4 py-2 font-bold text-black"
        >
          {t("games.precision.open_lobby")}
        </button>
      </div>
    </div>
  );
}
