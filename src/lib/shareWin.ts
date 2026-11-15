// src/lib/shareWin.ts
//
// The copy, the destinations and the share PAGE for "share this win".
//
// Solitaire already knows exactly how long a run took: a completed duel carries
// the server's own startedAt/endedAt, a solo board carries its measured elapsed
// time. The player should never have to retype that, so the number in the post
// comes from the same value the result screen shows — one source, no guesswork.
//
// TRILINGUAL: the app ships en/fr/es, so the post and the card are written in
// the language the player is using. Game and mode arrive as KEYS (`"duel"`,
// `"ranked"`) rather than display strings, so a label can never leak English
// into a French post; an unknown key is rendered verbatim, which keeps the door
// open for a future game to opt in without touching this file.
//
// THE LINK IS A PAGE, NOT THE LOBBY: every share points at /share/win with the
// result encoded in the query. That page's og:image is the generated card, so a
// shared link previews the actual run instead of the site's generic artwork.
//
// Nothing here posts on a player's behalf. Every destination is a plain compose
// URL opened in the player's own signed-in account, or the native share sheet on
// a device that has one; no SDK, no token, no background request. The result is
// the player's to publish or discard.

import { formatDuration } from "./solitaire-duel/soloStats.js";
import { getSiteUrl } from "./siteUrl";

export type ShareLocale = "en" | "fr" | "es";

export const SHARE_LOCALES: readonly ShareLocale[] = ["en", "fr", "es"];

/** Which game the win belongs to. Unknown keys render verbatim. */
export type ShareGameKey = "solitaire" | "daily" | "duel";

/** How it was played. Null for a solo run with no mode to name. */
export type ShareModeKey = "ranked" | "practice" | "solo";

export type WinShareInput = {
  /** Game KEY ("solitaire" | "daily" | "duel"), or a literal name. */
  game: string;
  /** Mode KEY ("ranked" | "practice" | "solo"), or null. */
  mode?: string | null;
  /** Measured time to finish, in ms. The number the result screen displays. */
  durationMs?: number | null;
  /** Accepted moves, when the surface counts them (solo only). */
  moves?: number | null;
  /** Explicit destination. When absent, the generated share page is used. */
  url?: string | null;
  /**
   * The member badge the player wears, as the SERVER resolved it ("PRO" or
   * "FOUNDER"). Never a client guess: unknown or malformed values are dropped
   * rather than printed, so nobody can label themselves a founder in a post.
   */
  badge?: string | null;
};

export type ShareDestination = {
  id: "x" | "facebook" | "whatsapp" | "telegram" | "reddit";
  label: string;
  href: string;
};

/** Where a shared win points. Also the page whose og:image is the card. */
export const SHARE_PAGE_PATH = "/share/win";

/** The generated card, keyed by the same query as the share page. */
export const SHARE_CARD_PATH = "/api/share/win-card";

/** A card is a run, not a livestream: nothing longer than a day is believable. */
export const SHARE_CARD_MAX_MS = 24 * 60 * 60 * 1000;

type LocaleCopy = {
  games: Record<string, string>;
  modes: Record<string, string>;
  /** "I won …" sentence, assembled from the parts the caller has. */
  won: (parts: {
    subject: string;
    time: string | null;
    moves: number | null;
    badge: string | null;
  }) => string;
  movesWord: string;
  solved: string;
  footer: string;
  member: (founder: boolean) => string;
  memberTagline: string;
  memberCardTitle: string;
  memberCardRole: (founder: boolean) => string;
};

const COPY: Record<ShareLocale, LocaleCopy> = {
  en: {
    games: { solitaire: "Solitaire", daily: "Daily Solitaire", duel: "Solitaire Duel" },
    modes: { ranked: "Ranked", practice: "Play vs AI", solo: "Solo" },
    won: ({ subject, time, moves, badge }) =>
      [
        `I won ${subject}`,
        time ? `in ${time}` : "",
        moves ? `— ${moves} moves` : "",
        badge ? `(${badge})` : "",
      ]
        .filter(Boolean)
        .join(" ") + ". Think you can beat that? #GRYND",
    movesWord: "moves",
    solved: "SOLVED",
    footer: "grynd.dedyn.io  ·  #GRYND",
    member: (founder) =>
      `I'm a GRYND PRO ${founder ? "founder" : "member"} — supporting independent competitive gaming. #GRYND`,
    memberTagline: "Supporting independent competitive gaming",
    memberCardTitle: "GRYND PRO",
    memberCardRole: (founder) => (founder ? "FOUNDER" : "MEMBER"),
  },
  fr: {
    games: {
      solitaire: "Solitaire",
      daily: "Solitaire quotidien",
      duel: "Solitaire Duel",
    },
    modes: { ranked: "Classé", practice: "Contre l'IA", solo: "Solo" },
    won: ({ subject, time, moves, badge }) =>
      [
        `J'ai gagné ${subject}`,
        time ? `en ${time}` : "",
        moves ? `— ${moves} coups` : "",
        badge ? `(${badge})` : "",
      ]
        .filter(Boolean)
        .join(" ") + ". Tu fais mieux ? #GRYND",
    movesWord: "coups",
    solved: "RÉSOLU",
    footer: "grynd.dedyn.io  ·  #GRYND",
    member: (founder) =>
      `Je suis ${founder ? "fondateur" : "membre"} GRYND PRO — je soutiens le jeu compétitif indépendant. #GRYND`,
    memberTagline: "Je soutiens le jeu compétitif indépendant",
    memberCardTitle: "GRYND PRO",
    memberCardRole: (founder) => (founder ? "FONDATEUR" : "MEMBRE"),
  },
  es: {
    games: { solitaire: "Solitario", daily: "Solitario diario", duel: "Duelo de Solitario" },
    modes: { ranked: "Clasificatoria", practice: "Contra la IA", solo: "Solo" },
    won: ({ subject, time, moves, badge }) =>
      [
        `Gané ${subject}`,
        time ? `en ${time}` : "",
        moves ? `— ${moves} jugadas` : "",
        badge ? `(${badge})` : "",
      ]
        .filter(Boolean)
        .join(" ") + ". ¿Puedes superarlo? #GRYND",
    movesWord: "jugadas",
    solved: "RESUELTO",
    footer: "grynd.dedyn.io  ·  #GRYND",
    member: (founder) =>
      `Soy ${founder ? "fundador" : "miembro"} de GRYND PRO — apoyo el juego competitivo independiente. #GRYND`,
    memberTagline: "Apoyo el juego competitivo independiente",
    memberCardTitle: "GRYND PRO",
    memberCardRole: (founder) => (founder ? "FUNDADOR" : "MIEMBRO"),
  },
};

/**
 * The share PANEL's own words — the controls, not the post.
 *
 * These live beside the post copy for one reason: a panel that says "Share
 * win" in French but "Save card" in English is worse than either language on
 * its own, and keeping them in the same table is what stops that drift. They
 * are UI labels, so they are short, verb-led and do not name the platform.
 */
export type SharePanelCopy = {
  /** Popup button. */
  shareWin: string;
  /** History-row pill. */
  share: string;
  /** Profile badge button. */
  shareBadge: string;
  /** Accessible name of the win panel. */
  groupWin: string;
  /** Accessible name of the badge panel. */
  groupBadge: string;
  saveCard: string;
  shareImage: string;
  copy: string;
  /** Native share-sheet button. */
  native: string;
  /** Status lines. */
  shared: string;
  copied: string;
  copyBlocked: string;
  cardShared: string;
  cardFailed: string;
  autoFailed: string;
};

const PANEL: Record<ShareLocale, SharePanelCopy> = {
  en: {
    shareWin: "Share win",
    share: "Share",
    shareBadge: "Share badge",
    groupWin: "Share this win",
    groupBadge: "Share your GRYND PRO badge",
    saveCard: "Save card",
    shareImage: "Share image",
    copy: "Copy",
    native: "Share…",
    shared: "Shared.",
    copied: "Copied — paste it anywhere.",
    copyBlocked: "Copy blocked by the browser.",
    cardShared: "Card shared.",
    cardFailed: "Could not share the card. Save it instead.",
    autoFailed: "Could not share automatically. Use a link below.",
  },
  fr: {
    shareWin: "Partager la victoire",
    share: "Partager",
    shareBadge: "Partager le badge",
    groupWin: "Partager cette victoire",
    groupBadge: "Partager votre badge GRYND PRO",
    saveCard: "Enregistrer la carte",
    shareImage: "Partager l'image",
    copy: "Copier",
    native: "Partager…",
    shared: "Partagé.",
    copied: "Copié — colle-le où tu veux.",
    copyBlocked: "Copie bloquée par le navigateur.",
    cardShared: "Carte partagée.",
    cardFailed: "Impossible de partager la carte. Enregistre-la plutôt.",
    autoFailed: "Partage automatique impossible. Utilise un lien ci-dessous.",
  },
  es: {
    shareWin: "Compartir victoria",
    share: "Compartir",
    shareBadge: "Compartir insignia",
    groupWin: "Compartir esta victoria",
    groupBadge: "Comparte tu insignia GRYND PRO",
    saveCard: "Guardar tarjeta",
    shareImage: "Compartir imagen",
    copy: "Copiar",
    native: "Compartir…",
    shared: "Compartido.",
    copied: "Copiado: pégalo donde quieras.",
    copyBlocked: "El navegador bloqueó la copia.",
    cardShared: "Tarjeta compartida.",
    cardFailed: "No se pudo compartir la tarjeta. Guárdala.",
    autoFailed: "No se pudo compartir automáticamente. Usa un enlace.",
  },
};

/** Every label the share panel renders, in the player's language. */
export function sharePanelCopy(locale: ShareLocale = "en"): SharePanelCopy {
  return PANEL[locale];
}

/**
 * A player's standing on a board, for the podium's share entry.
 *
 * The rank and the points are the SERVER's numbers, taken from the row the
 * leaderboard rendered — not recomputed from the viewer's screen.
 */
export type LadderShareInput = {
  /** 1-based position on the board. */
  rank: number;
  /** Points the position is built on (trophies, wins, Elo — whatever the board ranks by). */
  score?: number | null;
  /** Absolute page to send people to. Defaults to the leaderboard itself. */
  url?: string | null;
};

const LADDER: Record<
  ShareLocale,
  { tag: string; text: (parts: { rank: number; score: string | null }) => string }
> = {
  en: {
    tag: "en-US",
    text: ({ rank, score }) =>
      `I'm #${rank} on the GRYND leaderboard${score !== null ? ` with ${score} points` : ""}. Think you can climb higher? #GRYND`,
  },
  fr: {
    tag: "fr-FR",
    text: ({ rank, score }) =>
      `Je suis n°${rank} du classement GRYND${score !== null ? ` avec ${score} points` : ""}. Tu peux faire mieux ? #GRYND`,
  },
  es: {
    tag: "es-ES",
    text: ({ rank, score }) =>
      `Soy n.º ${rank} en la clasificación de GRYND${score !== null ? ` con ${score} puntos` : ""}. ¿Puedes subir más? #GRYND`,
  },
};

/** The post for a podium standing. Null when there is no real rank to brag about. */
export function buildLadderShareText(
  { rank, score = null }: LadderShareInput,
  locale: ShareLocale = "en",
): string | null {
  const position = Number(rank);
  if (!Number.isInteger(position) || position < 1) return null;
  const points = safeCount(score);
  // Grouped in the reader's own convention (1,450 / 1 450 / 1.450). The rank
  // itself is never localized into words — "#2" reads the same everywhere.
  const formatted =
    points === null ? null : new Intl.NumberFormat(LADDER[locale].tag).format(points);
  return LADDER[locale].text({ rank: position, score: formatted });
}

/** The leaderboard is what a standing should link to. */
export function ladderShareUrl(base?: string | null): string {
  const origin =
    base ||
    (typeof window !== "undefined" && window.location?.origin) ||
    getSiteUrl();
  return `${origin}/classement`;
}

/** Narrow any stored/settings value to a supported locale. */
export function shareLocale(value?: string | null): ShareLocale {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "fr" || normalized === "es" ? normalized : "en";
}

/** The localized game name for a key (an unknown key is shown as given). */
export function shareGameLabel(game: string, locale: ShareLocale = "en"): string {
  const key = String(game ?? "").trim().toLowerCase();
  return COPY[locale].games[key] ?? String(game ?? "");
}

/** The localized mode name for a key (an unknown key is shown as given). */
export function shareModeLabel(mode?: string | null, locale: ShareLocale = "en"): string | null {
  if (!mode) return null;
  const key = String(mode).trim().toLowerCase();
  return COPY[locale].modes[key] ?? String(mode);
}

/** The word on the card's headline when a run has no named mode. */
export function shareSolvedLabel(locale: ShareLocale = "en"): string {
  return COPY[locale].solved;
}

/** The card's move count line, or null when the surface counts no moves. */
export function shareMovesLabel(
  moves: number | null | undefined,
  locale: ShareLocale = "en",
): string | null {
  const count = Number(moves);
  if (!Number.isFinite(count) || count <= 0) return null;
  return `${Math.round(count)} ${COPY[locale].movesWord.toUpperCase()}`;
}

export const SHARE_FALLBACK_PATH = "/casino/solitaire-duel";

/**
 * The badge as it may appear in a public post: `"GRYND PRO"` or
 * `"GRYND Founder"`.
 *
 * The input is whatever the SERVER resolved (see /api/membership/badge);
 * anything else — a stale value, a lowercase guess, a tampered payload — is
 * dropped, so a post can never claim a badge the account does not hold.
 */
export function shareBadgeLabel(badge?: string | null): string | null {
  const value = String(badge ?? "").trim().toUpperCase();
  if (value === "FOUNDER") return "GRYND Founder";
  if (value === "PRO") return "GRYND PRO";
  return null;
}

function safeCount(value: number | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * The time as the result screen writes it (`m:ss`, or `h:mm:ss` past an hour).
 * `null` when the surface could not measure a duration — the copy then omits the
 * time rather than printing a dash or a fake zero.
 */
export function shareTimeLabel(durationMs?: number | null): string | null {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return formatDuration(ms);
}

/**
 * The post body. Deterministic, so the same win always shares the same words —
 * and the duration is a hard requirement: a win with a measured time always
 * names it, in the player's own language.
 */
export function buildWinShareText(
  { game, mode = null, durationMs = null, moves = null, badge = null }: WinShareInput,
  locale: ShareLocale = "en",
): string {
  const copy = COPY[locale];
  const modeLabel = shareModeLabel(mode, locale);
  const gameLabel = shareGameLabel(game, locale);
  return copy.won({
    subject: modeLabel ? `${gameLabel} (${modeLabel})` : gameLabel,
    time: shareTimeLabel(durationMs),
    moves: safeCount(moves),
    badge: shareBadgeLabel(badge),
  });
}

/** The member's own post — the mark in the text, straight from the server. */
export function buildMemberShareText(
  badge?: string | null,
  locale: ShareLocale = "en",
): string | null {
  const label = shareBadgeLabel(badge);
  if (!label) return null;
  return COPY[locale].member(label === "GRYND Founder");
}

/** Tagline + role for the member card, localized. */
export function memberCardCopy(
  badge?: string | null,
  locale: ShareLocale = "en",
): { title: string; role: string; tagline: string; footer: string } | null {
  const label = shareBadgeLabel(badge);
  if (!label) return null;
  const copy = COPY[locale];
  return {
    title: copy.memberCardTitle,
    role: copy.memberCardRole(label === "GRYND Founder"),
    tagline: copy.memberTagline,
    footer: copy.footer,
  };
}

/**
 * The share page's query: the whole run, in a handful of validated fields.
 * Locale rides along so the page and its card open in the sharer's language.
 */
export function sharePageQuery(
  input: WinShareInput,
  locale: ShareLocale = "en",
): string {
  const params = new URLSearchParams();
  const game = String(input.game ?? "").trim().toLowerCase();
  params.set("g", game || "solitaire");
  if (input.mode) params.set("m", String(input.mode).trim().toLowerCase());
  const time = Number(input.durationMs);
  if (Number.isFinite(time) && time > 0) {
    params.set("t", String(Math.min(Math.round(time), SHARE_CARD_MAX_MS)));
  }
  const moves = safeCount(input.moves);
  if (moves) params.set("mv", String(moves));
  const badge = shareBadgeLabel(input.badge);
  if (badge) params.set("b", badge === "GRYND Founder" ? "FOUNDER" : "PRO");
  if (locale !== "en") params.set("l", locale);
  return `?${params.toString()}`;
}

/** The share page for this run (relative: the caller supplies the origin). */
export function sharePageHref(input: WinShareInput, locale: ShareLocale = "en"): string {
  return `${SHARE_PAGE_PATH}${sharePageQuery(input, locale)}`;
}

/** The generated card for this run, relative like the page above. */
export function shareCardHref(input: WinShareInput, locale: ShareLocale = "en"): string {
  return `${SHARE_CARD_PATH}${sharePageQuery(input, locale)}`;
}

/**
 * Absolute URL the post should carry. An explicit `url` wins; otherwise the
 * share page is used, because its og:image is the card itself.
 */
export function winShareUrl(
  input: WinShareInput = { game: "solitaire" },
  base?: string | null,
): string {
  if (input.url) return input.url;
  const origin =
    base ||
    (typeof window !== "undefined" && window.location?.origin) ||
    getSiteUrl();
  return `${origin}${SHARE_PAGE_PATH}${sharePageQuery(input)}`;
}

/** The member's landing page: the offer they are supporting. */
export function memberShareUrl(base?: string | null): string {
  const origin =
    base ||
    (typeof window !== "undefined" && window.location?.origin) ||
    getSiteUrl();
  return `${origin}/upgrade-pro`;
}

type QuerySource =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

function queryReader(source: QuerySource): (key: string) => string | null {
  if (!source) return () => null;
  if (source instanceof URLSearchParams) {
    return (key) => source.get(key);
  }
  return (key) => {
    const value = source[key];
    if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
    return typeof value === "string" ? value : null;
  };
}

/**
 * Read a share query back. Everything is validated and clamped here rather than
 * at each render: this is the untrusted input behind a public URL, so an
 * arbitrary `t=99999999999` or a `g=<script>` cannot reach the card.
 */
export function parseShareCardQuery(source: QuerySource): {
  input: WinShareInput;
  locale: ShareLocale;
} {
  const get = queryReader(source);

  const gameRaw = (get("g") ?? "").trim().toLowerCase();
  const game = ["solitaire", "daily", "duel"].includes(gameRaw) ? gameRaw : "solitaire";

  const modeRaw = (get("m") ?? "").trim().toLowerCase();
  const mode = ["ranked", "practice", "solo"].includes(modeRaw) ? modeRaw : null;

  const time = Number(get("t"));
  const durationMs =
    Number.isFinite(time) && time > 0
      ? Math.min(Math.round(time), SHARE_CARD_MAX_MS)
      : null;

  const movesRaw = Number(get("mv"));
  const moves =
    Number.isInteger(movesRaw) && movesRaw > 0 && movesRaw <= 9999 ? movesRaw : null;

  const badgeRaw = (get("b") ?? "").trim().toUpperCase();
  const badge = badgeRaw === "PRO" || badgeRaw === "FOUNDER" ? badgeRaw : null;

  return { input: { game, mode, durationMs, moves, badge }, locale: shareLocale(get("l")) };
}

/**
 * One entry per destination, built from the same text and URL so a shared post
 * can never disagree with the panel it came from. Order is deliberate: the two
 * places people actually post wins first, then the group chats.
 */
export function shareDestinations(text: string, url: string): ShareDestination[] {
  const encodedText = encodeURIComponent(text);
  const encodedUrl = encodeURIComponent(url);
  const textWithUrl = encodeURIComponent(`${text} ${url}`);

  return [
    {
      id: "x",
      label: "X",
      href: `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`,
    },
    { id: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${textWithUrl}` },
    {
      id: "facebook",
      label: "Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    },
    {
      id: "telegram",
      label: "Telegram",
      href: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
    },
    {
      id: "reddit",
      label: "Reddit",
      href: `https://www.reddit.com/submit?url=${encodedUrl}&title=${encodedText}`,
    },
  ];
}

/** The win destinations: the post body's own words, plus the page. */
export function shareWinLinks(
  input: WinShareInput,
  url: string,
  locale: ShareLocale = "en",
): ShareDestination[] {
  return shareDestinations(buildWinShareText(input, locale), url);
}

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

/**
 * The one action behind the primary button: the native sheet where the platform
 * has one (the right thing on a phone), otherwise copy the post to the
 * clipboard so it can be pasted anywhere. A user who closes the sheet is
 * "cancelled", not an error — we do not fall back to copying behind their back.
 */
export async function shareWin(
  input: WinShareInput,
  locale: ShareLocale = "en",
): Promise<ShareOutcome> {
  const text = buildWinShareText(input, locale);
  const url = winShareUrl(input);
  const payload = { title: "GRYND", text: `${text} ${url}`, url };

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share(payload);
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
      // A platform that exposes share but refuses it (permissions, insecure
      // context): fall through to the clipboard instead of failing the click.
    }
  }

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(`${text} ${url}`);
      return "copied";
    }
  } catch {
    // Clipboard blocked: the copy-paste fallback below is the caller's problem,
    // and the social links in the panel still work.
  }
  return "failed";
}
