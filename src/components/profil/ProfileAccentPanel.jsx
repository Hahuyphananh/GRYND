"use client";

// src/components/profil/ProfileAccentPanel.jsx
//
// The accent-colour card, extracted from the profile page. Customisation is
// free for everyone: the page holds the value and the save handler, so this
// file never decides who may customise.

import { ACCENT_COLORS } from "../../lib/profileCosmetics";
import { useTranslation } from "../../hooks/useTranslation";

export default function ProfileAccentPanel({ accent, onAccentChange, onSave, message }) {
  const { t } = useTranslation();

  return (
    <div className="mt-8 rounded-xl border border-sky-400/35 bg-[color:var(--bg-surface)] p-6 shadow-[var(--shadow-raise)]">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-xl text-sky-300">
          {t("profile.customization.title", "Profile Customization")}
        </h2>
      </div>

      <>
        <p className="mb-4 text-sm text-gray-300">
          {t(
            "profile.customization.note",
            "Accent color — the ring around your profile card. Free for everyone.",
          )}
        </p>

          <p className="mb-2 text-sm font-semibold text-sky-300">
            {t("profile.customization.accent", "Accent color")}
          </p>
          <div className="mb-2 flex flex-wrap gap-2">
            {ACCENT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => onAccentChange(color)}
                aria-label={t("profile.customization.setAccent", {
                  color,
                })}
                title={color}
                className={`h-8 w-8 rounded-full border-2 transition ${
                  accent.toLowerCase() === color.toLowerCase()
                    ? "scale-110 border-white"
                    : "border-white/20 hover:border-white/60"
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <div className="mb-4 flex items-center gap-2">
            <input
              type="color"
              value={accent}
              onChange={(e) => onAccentChange(e.target.value)}
              aria-label={t(
                "profile.customization.accentLabel",
                "Custom accent color",
              )}
              className="h-8 w-10 cursor-pointer rounded-sm border border-white/20 bg-transparent"
            />
            <input
              type="text"
              value={accent}
              onChange={(e) => onAccentChange(e.target.value.trim())}
              maxLength={7}
              aria-label={t(
                "profile.customization.accentHexLabel",
                "Custom accent hex value",
              )}
              className="w-28 rounded-sm border border-white/20 bg-[color:var(--bg-panel)] px-2 py-1 text-sm text-white focus:border-sky-400 focus:outline-hidden"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSave}
              className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-[color:var(--on-accent)] transition hover:bg-sky-400 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
            >
              {t("profile.customization.save", "Save customization")}
            </button>
          </div>

          {message && <p className="mt-3 text-sm text-sky-300">{message}</p>}
      </>
    </div>
  );
}
