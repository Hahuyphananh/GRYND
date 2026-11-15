"use client";

// The unlimited card's live allowance: how many puzzles are left today.
//
// The number is the server's, never a guess. `allowanceOnly=1` asks the puzzle
// route for the count WITHOUT building a verified position, so opening /play
// never pays for the engine's deal search just to print a number.
//
// Nothing is rendered when the allowance cannot be read: a hub card must not
// claim a figure it does not have.

import { useEffect, useState } from "react";

import { useTranslation } from "../../hooks/useTranslation";

type Allowance = {
  unlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
};

export default function PuzzleAllowanceBadge() {
  const { t } = useTranslation();
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/solitaire/puzzle?kind=unlimited&allowanceOnly=1", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (cancelled) return;
        const data = body?.data?.allowance;
        if (!response.ok || !body?.success || !data) {
          setFailed(true);
          return;
        }
        setAllowance(data as Allowance);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null;
  if (!allowance) return <>{t("playHub.cards.unlimited.checking")}</>;

  return (
    <>
      {allowance.unlimited
        ? t("playHub.cards.unlimited.pro")
        : t("playHub.cards.unlimited.remaining", {
            remaining: allowance.remaining ?? 0,
            limit: allowance.limit ?? 5,
          })}
    </>
  );
}
