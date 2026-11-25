// src/lib/shareCard.ts
//
// THE CARD — a 1200×630 PNG a player can post anywhere.
//
// A link preview is not a card: it shows the site's generic artwork, not the
// run. This draws the run itself — the mode, the time, the move count, and the
// member badge the server says the player wears — onto a canvas the popup can
// preview, download, or hand to the native share sheet as a file.
//
// Two layers on purpose:
//   - `winCardFacts()` is pure: the exact strings and the badge rule, testable
//     without a DOM.
//   - `drawWinCard()` only paints what the facts say, so the card can never
//     disagree with the text the player just previewed.
//
// 1200×630 is the size X, Facebook, LinkedIn and Slack expect for a landscape
// preview, so the same file works as an image post and as a link thumbnail —
// and /api/share/win-card renders the SAME fields server-side for og:image.
//
// Everything is trilingual: the labels come from lib/shareWin.ts, so a French
// player's card says "RÉSOLU" and "COUPS", not "SOLVED" and "MOVES".

import {
  memberCardCopy,
  shareBadgeLabel,
  shareGameLabel,
  shareModeLabel,
  shareMovesLabel,
  shareSolvedLabel,
  shareTimeLabel,
  type ShareLocale,
  type WinShareInput,
} from "./shareWin";

/** Landscape social-card dimensions. */
export const WIN_CARD_WIDTH = 1200;
export const WIN_CARD_HEIGHT = 630;

const CARD_INK = "#04070f";
const CARD_ACCENT = "#34d399";
const CARD_MUTED = "#8fa3bf";

export type WinCardFacts = {
  /** Top-left wordmark. */
  wordmark: string;
  /** "SOLITAIRE DUEL · CLASSÉ" — what was won, and how. */
  headline: string;
  /** The hero figure: `m:ss`. Null when the surface could not measure a run. */
  time: string | null;
  /** "84 COUPS", or null when the surface does not count moves. */
  detail: string | null;
  /** "GRYND PRO" / "GRYND Founder", already validated. */
  badge: string | null;
  /** Footer line that travels with the image after it leaves the app. */
  footer: string;
};

export type MemberCardFacts = {
  wordmark: string;
  title: string;
  role: string;
  tagline: string;
  footer: string;
};

/**
 * The exact words on the card. Deterministic, and derived from the SAME helpers
 * the share text uses, so the image and the post can never disagree.
 */
export function winCardFacts(
  { game, mode = null, durationMs = null, moves = null, badge = null }: WinShareInput,
  locale: ShareLocale = "en",
): WinCardFacts {
  const headlineParts = [shareGameLabel(game, locale).trim().toUpperCase()];
  const modeLabel = shareModeLabel(mode, locale);
  headlineParts.push((modeLabel ?? shareSolvedLabel(locale)).trim().toUpperCase());

  return {
    wordmark: "GRYND",
    headline: headlineParts.filter(Boolean).join("  ·  "),
    time: shareTimeLabel(durationMs),
    detail: shareMovesLabel(moves, locale),
    badge: shareBadgeLabel(badge),
    footer: "grynd.dedyn.io  ·  #GRYND",
  };
}

/** The member's own card: the mark, not a run. */
export function memberCardFacts(
  badge?: string | null,
  locale: ShareLocale = "en",
): MemberCardFacts | null {
  const copy = memberCardCopy(badge, locale);
  if (!copy) return null;
  return {
    wordmark: "GRYND",
    title: copy.title,
    role: copy.role,
    tagline: copy.tagline,
    footer: copy.footer,
  };
}

/** Where a saved card lands on disk. Stable, so two saves do not duplicate. */
export function winCardFilename(): string {
  return "grynd-solitaire-win.png";
}

/** Where a saved member card lands on disk. */
export function memberCardFilename(): string {
  return "grynd-pro.png";
}

type Ctx = Pick<
  CanvasRenderingContext2D,
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "font"
  | "textAlign"
  | "textBaseline"
  | "globalAlpha"
  | "createLinearGradient"
  | "fillRect"
  | "strokeRect"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "quadraticCurveTo"
  | "closePath"
  | "fill"
  | "stroke"
  | "save"
  | "restore"
  | "fillText"
>;

/** A rounded rectangle path on any canvas implementation. */
function roundedRect(
  ctx: Ctx,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Shared ground: deep navy fading to black, an emerald glow, a thin frame. */
function paintGround(ctx: Ctx) {
  const width = WIN_CARD_WIDTH;
  const height = WIN_CARD_HEIGHT;

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#071226");
  background.addColorStop(0.55, CARD_INK);
  background.addColorStop(1, "#02060d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createLinearGradient(width / 2 - 260, 0, width / 2 + 260, 0);
  glow.addColorStop(0, "rgba(52, 211, 153, 0)");
  glow.addColorStop(0.5, "rgba(52, 211, 153, 0.18)");
  glow.addColorStop(1, "rgba(52, 211, 153, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(width / 2 - 260, 150, 520, 260);

  ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
  ctx.lineWidth = 2;
  roundedRect(ctx, 28, 28, width - 56, height - 56, 28);
  ctx.stroke();
}

function paintWordmark(ctx: Ctx, wordmark: string) {
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 54px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillText(wordmark, 72, 118);
  ctx.fillStyle = CARD_ACCENT;
  ctx.fillRect(72, 138, 96, 5);
}

/** The member's mark, drawn only when the server said they hold it. */
function paintBadgeChip(ctx: Ctx, badge: string) {
  const width = WIN_CARD_WIDTH;
  ctx.font = "800 26px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(52, 211, 153, 0.16)";
  roundedRect(ctx, width - 72 - 300, 74, 300, 58, 29);
  ctx.fill();
  ctx.strokeStyle = "rgba(52, 211, 153, 0.55)";
  ctx.lineWidth = 2;
  roundedRect(ctx, width - 72 - 300, 74, 300, 58, 29);
  ctx.stroke();
  ctx.fillStyle = CARD_ACCENT;
  ctx.fillText(badge, width - 96, 113);
  ctx.textAlign = "left";
}

function paintFooter(ctx: Ctx, footer: string) {
  ctx.fillStyle = CARD_MUTED;
  ctx.font = "600 26px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(footer, 72, WIN_CARD_HEIGHT - 72);
}

/**
 * Paint the win card. Every coordinate is inside 1200×630 by construction — the
 * layout is fixed, not measured — so a long wordmark or a four-digit move count
 * cannot push content off the image.
 */
export function drawWinCard(
  ctx: Ctx,
  input: WinShareInput,
  locale: ShareLocale = "en",
): WinCardFacts {
  const facts = winCardFacts(input, locale);

  paintGround(ctx);
  paintWordmark(ctx, facts.wordmark);
  if (facts.badge) paintBadgeChip(ctx, facts.badge);

  // Headline: what was won, and how.
  ctx.fillStyle = CARD_MUTED;
  ctx.font = "700 30px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillText(facts.headline, 72, 232);

  // Hero time — the number the player actually wants to show off.
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 178px ui-monospace, 'SFMono-Regular', Menlo, monospace";
  ctx.fillText(facts.time ?? "WIN", 68, 404);

  // Detail row: moves, when the surface counted them.
  if (facts.detail) {
    ctx.fillStyle = "rgba(226, 232, 240, 0.72)";
    ctx.font = "700 30px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.fillText(facts.detail, 76, 456);
  }

  paintFooter(ctx, facts.footer);
  return facts;
}

/**
 * Paint the member card: the PRO mark itself, for a player proud of backing the
 * project. Same frame and ground as a win card, so the two look like a set.
 */
export function drawMemberCard(
  ctx: Ctx,
  badge: string,
  locale: ShareLocale = "en",
): MemberCardFacts | null {
  const facts = memberCardFacts(badge, locale);
  if (!facts) return null;

  paintGround(ctx);
  paintWordmark(ctx, facts.wordmark);
  paintBadgeChip(ctx, facts.title);

  ctx.fillStyle = "#ffffff";
  ctx.font = "900 168px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillText(facts.role, 68, 396);

  ctx.fillStyle = "rgba(226, 232, 240, 0.78)";
  ctx.font = "700 34px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillText(facts.tagline, 72, 462);

  paintFooter(ctx, facts.footer);
  return facts;
}

function paintToDataUrl(
  paint: (ctx: Ctx) => void,
): string | null {
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = WIN_CARD_WIDTH;
    canvas.height = WIN_CARD_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    paint(ctx);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Build the win card as a data URL, or null where there is no DOM (server
 * render) or no canvas support. The caller decides what to do with null: the
 * text share still works, so a card failure never blocks a win.
 */
export function createWinCardDataUrl(
  input: WinShareInput,
  locale: ShareLocale = "en",
): string | null {
  return paintToDataUrl((ctx) => drawWinCard(ctx, input, locale));
}

/** Build the member card as a data URL. Null for a non-member. */
export function createMemberCardDataUrl(
  badge?: string | null,
  locale: ShareLocale = "en",
): string | null {
  if (!memberCardFacts(badge, locale)) return null;
  return paintToDataUrl((ctx) => drawMemberCard(ctx, String(badge), locale));
}

/** The data URL as a File, for the native share sheet's `files` payload. */
export function winCardFile(
  dataUrl: string,
  filename: string = winCardFilename(),
): File | null {
  try {
    const [meta, base64] = dataUrl.split(",");
    if (!base64 || !/^data:image\/png;base64/.test(meta ?? "")) return null;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: "image/png" });
  } catch {
    return null;
  }
}
