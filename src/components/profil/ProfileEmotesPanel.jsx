"use client";

// src/components/profil/ProfileEmotesPanel.jsx
//
// The emotes card, extracted from the profile page. It opens the loadout
// manager and renders the strip; the page keeps the picker itself, so this
// file can never mint or equip an emote on its own.

import EmoteLoadoutStrip from "../EmoteLoadoutStrip";
import { useTranslation } from "../../hooks/useTranslation";

export default function ProfileEmotesPanel({ onManage }) {
  const { t } = useTranslation();

  return (
    <div className="mt-8 rounded-xl border border-white/10 bg-[color:var(--bg-surface)] p-6 shadow-[var(--shadow-raise)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl text-slate-200">
            {t("profile.emotes.title", "Emotes")}
          </h2>
          <p className="mt-1 text-sm text-gray-300">
            {t(
              "profile.emotes.description",
              "Choose up to 9 animated emotes to use in games. GG and NICE MOVE are always available.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onManage(true)}
          className="rounded-lg bg-cyan-600/80 px-4 py-2 text-sm font-semibold text-[color:var(--on-accent)] transition hover:bg-cyan-500 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-200/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
        >
          {t("profile.emotes.manage", "Manage emotes")}
        </button>
      </div>
      <EmoteLoadoutStrip onChange={onManage} />
    </div>
  );
}
