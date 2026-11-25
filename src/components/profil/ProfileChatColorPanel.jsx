"use client";

// src/components/profil/ProfileChatColorPanel.jsx
//
// The chat name-colour card, plus its palette. The ten values are player
// data (selectable colours), which is why they live here rather than in the
// token layer. The page owns the selection and the save handlers.

import { CHAT_COLORS } from "../../lib/profileCosmetics";
import { useTranslation } from "../../hooks/useTranslation";

export default function ProfileChatColorPanel({ chatColor, onChatColorChange, onSave, onReset, message, isMember, previewName }) {
  const { t } = useTranslation();

  return (
    <div className="mt-8 rounded-xl border border-emerald-400/35 bg-[color:var(--bg-surface)] p-6 shadow-[var(--shadow-raise)]">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="text-xl text-emerald-300">
          {t("profile.chatcolor.title", "Chat name color")}
        </h2>
        {!isMember && (
          <a
            href="/upgrade-pro"
            className="inline-flex items-center rounded-full border border-white/15 bg-cyan-500/10 px-3 py-1 text-sm font-medium text-cyan-200/90 transition hover:bg-cyan-500/25 hover:text-cyan-100"
          >
            {t("profile.membership.seePro", "See GRYND PRO")}
          </a>
        )}
      </div>

      <>
        <p className="mb-3 text-sm text-gray-300">
          {t(
            "profile.chatcolor.note",
            "Your name shows in this color in chat and on your game seats. Free for everyone.",
          )}
        </p>

          <div className="mb-3 flex flex-wrap gap-2">
            {CHAT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => onChatColorChange(color)}
                aria-label={t("profile.membership.setChatColor", {
                  color,
                })}
                title={color}
                className={`h-8 w-8 rounded-full border-2 transition ${
                  chatColor.toLowerCase() === color.toLowerCase()
                    ? "scale-110 border-white"
                    : "border-white/20 hover:border-white/60"
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>

          <div className="mb-3 flex items-center gap-2">
            <input
              type="color"
              value={chatColor}
              onChange={(e) => onChatColorChange(e.target.value)}
              aria-label={t(
                "profile.membership.chatColorLabel",
                "Custom chat color",
              )}
              className="h-8 w-10 cursor-pointer rounded-sm border border-white/20 bg-transparent"
            />
            <input
              type="text"
              value={chatColor}
              onChange={(e) => onChatColorChange(e.target.value.trim())}
              maxLength={7}
              aria-label={t(
                "profile.membership.chatColorHexLabel",
                "Custom chat color hex value",
              )}
              className="w-28 rounded-sm border border-white/20 bg-[color:var(--bg-panel)] px-2 py-1 text-sm text-white focus:border-emerald-400 focus:outline-hidden"
            />
          </div>

          <div className="mb-4 flex items-center gap-2 rounded-sm bg-black/30 px-3 py-2 text-sm">
            <span className="text-gray-400">
              {t("profile.membership.preview", "Preview:")}
            </span>
            <span className="font-bold" style={{ color: chatColor }}>
              {previewName}
            </span>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSave}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-[color:var(--on-accent)] transition hover:bg-emerald-400 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
            >
              {t("profile.membership.save", "Save color")}
            </button>
            <button
              type="button"
              onClick={onReset}
              className="rounded-lg border border-white/20 px-4 py-2 text-sm text-gray-300 transition hover:bg-white/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
            >
              {t("profile.membership.reset", "Reset")}
            </button>
          </div>

          {message && (
            <p className="mt-3 text-sm text-emerald-300">{message}</p>
          )}
      </>
    </div>
  );
}
