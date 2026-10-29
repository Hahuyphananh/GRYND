// src/lib/vast/parse.ts
//
// A deliberately NARROW, FAIL-CLOSED VAST 3.0 reader: InLine → Linear →
// progressive MediaFile. Nothing else is understood, and anything unexpected
// resolves to "no ad" rather than to something clever.
//
// WHY NO DOM / NO LIBRARY
// The XML is untrusted third-party input that is handed straight to the
// browser. A DOM parser would be a heavier dependency; `DOMParser` would work in
// the browser but leaves the parser untestable under Node. More importantly, the
// rules below are POLICY as much as parsing:
//
//   * `<Wrapper>` is refused outright. A wrapper is an instruction to fetch and
//     parse ANOTHER arbitrary URL; following it turns the player into an open
//     fetcher for whatever the provider (or anyone who can answer for it) says.
//     We never resolve wrappers.
//   * `<CompanionAds>`, `<Extensions>`, `<InteractiveCreativeFile>` and any
//     `MediaFile` carrying `apiFramework` (VPAID & friends) are ignored or
//     refused. VAST can describe HTML/JS to run; we only ever play a video file.
//   * `<ClickThrough>` is DETECTED but its URL is not returned at all. A
//     post-match ad must never navigate, so the player is given nothing it could
//     accidentally bind.
//   * `<!DOCTYPE>` / `<!ENTITY>` are rejected before parsing, and only the five
//     predefined entities plus numeric character references are decoded. No
//     external entities, no entity expansion.
//   * Every URL must be `https:` with no credentials; every media file must be
//     a `video/*` progressive file.
//
// The reader is an index-based scanner (not a regex over the whole document) so
// cost stays linear in the response size and malformed input throws instead of
// backtracking. Response size is capped by the caller as well.

/** Hard cap on the XML we are willing to parse (~9–10 KB in practice). */
export const MAX_VAST_XML_CHARS = 256 * 1024;

export type VastFailureReason =
  | "empty"
  | "oversized"
  | "malformed"
  | "unsafe-markup"
  | "no-ad"
  | "wrapper-unsupported"
  | "vpaid-unsupported"
  | "no-linear"
  | "no-media";

export interface VastMediaFile {
  /** Validated https URL, kept exactly as the provider wrote it. */
  url: string;
  /** Lower-cased MIME type, always `video/…`. */
  type: string;
  width: number | null;
  height: number | null;
  bitrate: number | null;
}

export interface VastTrackingEvent {
  /** Lower-cased VAST event name (`start`, `complete`, `skip`, …). */
  event: string;
  url: string;
}

export interface VastLinearAd {
  id: string | null;
  adSystem: string | null;
  durationSeconds: number | null;
  /** VAST 3 `skipoffset`. A hint for the player's own dismiss control. */
  skipOffsetSeconds: number | null;
  mediaFiles: VastMediaFile[];
  impressionUrls: string[];
  errorUrls: string[];
  tracking: VastTrackingEvent[];
  /**
   * `<ClickThrough>` was present. The URL is deliberately NOT exposed: this
   * flag exists so the behaviour can be asserted in tests, not so it can be
   * rendered.
   */
  hasClickThrough: boolean;
}

export type VastParseResult =
  | { ok: true; ads: VastLinearAd[] }
  | { ok: false; reason: VastFailureReason };

/**
 * Narrowing helper.
 *
 * This project compiles with `strict: false`, which disables discriminated-union
 * narrowing on `result.ok`, so callers use this type guard instead of an inline
 * property check (which TypeScript accepts but does not narrow here).
 */
export function isVastFailure(
  result: VastParseResult,
): result is { ok: false; reason: VastFailureReason } {
  return result.ok === false;
}

// ── Minimal XML tree ────────────────────────────────────────────────────────

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

class XmlSyntaxError extends Error {}

const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decodes the five predefined entities and numeric references only. */
function decodeEntities(raw: string): string {
  return raw.replace(
    /&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g,
    (match, body: string) => {
      if (body.charCodeAt(0) === 35 /* # */) {
        const isHex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return PREDEFINED_ENTITIES[body] ?? match;
    },
  );
}

/**
 * Parses a small XML document into a node tree.
 *
 * Rejects (throws): declarations other than an optional XML prolog, mismatched
 * or unterminated tags, and any trailing content after the root element.
 */
function parseXml(source: string): XmlNode {
  let i = 0;
  const length = source.length;

  const isNameStart = (ch: string) =>
    (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
  const isNameChar = (ch: string) =>
    isNameStart(ch) ||
    (ch >= "0" && ch <= "9") ||
    ch === "." ||
    ch === ":" ||
    ch === "-";
  const isSpace = (ch: string) =>
    ch === " " || ch === "\n" || ch === "\t" || ch === "\r";

  function skipSpace(): void {
    while (i < length && isSpace(source[i]!)) i += 1;
  }

  function readName(): string {
    const start = i;
    if (i >= length || !isNameStart(source[i]!)) {
      throw new XmlSyntaxError("expected a name");
    }
    i += 1;
    while (i < length && isNameChar(source[i]!)) i += 1;
    return source.slice(start, i);
  }

  function skipPast(marker: string): void {
    const end = source.indexOf(marker, i);
    if (end < 0) throw new XmlSyntaxError("unterminated construct");
    i = end + marker.length;
  }

  function parseElement(): XmlNode {
    i += 1; // "<"
    const name = readName();
    const attrs: Record<string, string> = Object.create(null);

    for (;;) {
      skipSpace();
      const ch = source[i];
      if (ch === undefined) throw new XmlSyntaxError("unterminated tag");

      if (ch === "/") {
        i += 1;
        if (source[i] !== ">") throw new XmlSyntaxError("expected >");
        i += 1;
        return { name, attrs, text: "", children: [] };
      }

      if (ch === ">") {
        i += 1;
        return parseContent(name, attrs);
      }

      const attrName = readName();
      skipSpace();
      if (source[i] !== "=") throw new XmlSyntaxError("expected =");
      i += 1;
      skipSpace();
      const quote = source[i];
      if (quote !== '"' && quote !== "'") {
        throw new XmlSyntaxError("expected a quoted value");
      }
      i += 1;
      const end = source.indexOf(quote, i);
      if (end < 0) throw new XmlSyntaxError("unterminated attribute");
      attrs[attrName] = decodeEntities(source.slice(i, end));
      i = end + 1;
    }
  }

  function parseContent(
    name: string,
    attrs: Record<string, string>,
  ): XmlNode {
    let text = "";
    const children: XmlNode[] = [];

    for (;;) {
      if (i >= length) throw new XmlSyntaxError("unterminated element");
      const ch = source[i]!;

      if (ch !== "<") {
        text += ch;
        i += 1;
        continue;
      }

      if (source.startsWith("<![CDATA[", i)) {
        const end = source.indexOf("]]>", i);
        if (end < 0) throw new XmlSyntaxError("unterminated CDATA");
        text += source.slice(i + 9, end);
        i = end + 3;
        continue;
      }

      if (source.startsWith("<!--", i)) {
        i += 4;
        skipPast("-->");
        continue;
      }

      if (source.startsWith("<?", i)) {
        i += 2;
        skipPast("?>");
        continue;
      }

      if (source.startsWith("</", i)) {
        i += 2;
        const closing = readName();
        if (closing !== name) throw new XmlSyntaxError("mismatched closing tag");
        skipSpace();
        if (source[i] !== ">") throw new XmlSyntaxError("expected >");
        i += 1;
        return { name, attrs, text: decodeEntities(text), children };
      }

      if (source[i] === "<" && source[i + 1] === "!") {
        throw new XmlSyntaxError("declaration rejected");
      }

      children.push(parseElement());
    }
  }

  skipSpace();
  if (source.startsWith("<?", i)) {
    i += 2;
    skipPast("?>");
    skipSpace();
  }
  if (source.startsWith("<!", i)) throw new XmlSyntaxError("declaration rejected");
  if (source[i] !== "<") throw new XmlSyntaxError("no root element");

  const root = parseElement();
  skipSpace();
  if (i !== length) throw new XmlSyntaxError("trailing content");
  return root;
}

// ── Tree helpers ────────────────────────────────────────────────────────────

function childOf(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((entry) => entry.name === name) ?? null;
}

function childrenOf(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((entry) => entry.name === name);
}

function textOf(node: XmlNode | null): string {
  return (node?.text ?? "").trim();
}

function intAttr(node: XmlNode, name: string): number | null {
  const raw = (node.attrs[name] ?? "").trim();
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** An https URL exactly as written, or null. No credentials, no rewriting. */
function httpsUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value || value.length > 2048) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;

  return value;
}

/** `HH:MM:SS` / `HH:MM:SS.mmm` → seconds, or null. */
function parseClock(raw: string | null | undefined): number | null {
  const value = (raw ?? "").trim();
  const match = /^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;

  const millis = match[4] ? Number(match[4].padEnd(3, "0")) / 1000 : 0;
  return hours * 3600 + minutes * 60 + seconds + millis;
}

function parseSkipOffset(
  linear: XmlNode,
  durationSeconds: number | null,
): number | null {
  const raw = (linear.attrs.skipoffset ?? "").trim();
  if (!raw) return null;

  if (raw.endsWith("%")) {
    const percent = Number.parseFloat(raw.slice(0, -1));
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
    if (durationSeconds === null) return null;
    return Math.round(((durationSeconds * percent) / 100) * 1000) / 1000;
  }

  return parseClock(raw);
}

// ── VAST extraction ─────────────────────────────────────────────────────────

function readMediaFiles(linear: XmlNode): VastMediaFile[] {
  const files: VastMediaFile[] = [];

  for (const group of childrenOf(linear, "MediaFiles")) {
    for (const file of childrenOf(group, "MediaFile")) {
      // VPAID and any other apiFramework creative is executable content, not a
      // video file. Never surface it.
      if ((file.attrs.apiFramework ?? "").trim()) continue;

      const delivery = (file.attrs.delivery ?? "").trim().toLowerCase();
      if (delivery && delivery !== "progressive") continue;

      const type = (file.attrs.type ?? "").trim().toLowerCase();
      if (!type.startsWith("video/")) continue;

      const url = httpsUrl(file.text);
      if (!url) continue;

      files.push({
        url,
        type,
        width: intAttr(file, "width"),
        height: intAttr(file, "height"),
        bitrate: intAttr(file, "bitrate"),
      });
    }
  }

  return files;
}

function readTracking(linear: XmlNode): VastTrackingEvent[] {
  const events: VastTrackingEvent[] = [];

  for (const group of childrenOf(linear, "TrackingEvents")) {
    for (const event of childrenOf(group, "Tracking")) {
      const name = (event.attrs.event ?? "").trim().toLowerCase();
      const url = httpsUrl(event.text);
      if (!name || !url) continue;
      events.push({ event: name, url });
    }
  }

  return events;
}

interface InlineReadResult {
  ad: VastLinearAd | null;
  reason: "no-linear" | "no-media" | "vpaid-unsupported" | null;
}

function readInline(adNode: XmlNode, inline: XmlNode): InlineReadResult {
  const impressionUrls = childrenOf(inline, "Impression")
    .map((node) => httpsUrl(node.text))
    .filter((url): url is string => url !== null);

  const errorUrls = childrenOf(inline, "Error")
    .map((node) => httpsUrl(node.text))
    .filter((url): url is string => url !== null);

  const linearNodes: XmlNode[] = [];
  for (const creatives of childrenOf(inline, "Creatives")) {
    for (const creative of childrenOf(creatives, "Creative")) {
      const linear = childOf(creative, "Linear");
      if (linear) linearNodes.push(linear);
    }
  }

  if (linearNodes.length === 0) return { ad: null, reason: "no-linear" };

  const hasInteractiveCreative = linearNodes.some(
    (linear) => childrenOf(linear, "InteractiveCreativeFile").length > 0,
  );

  const linear = linearNodes.find(
    (candidate) => readMediaFiles(candidate).length > 0,
  );

  if (!linear) {
    return {
      ad: null,
      reason: hasInteractiveCreative ? "vpaid-unsupported" : "no-media",
    };
  }

  const mediaFiles = readMediaFiles(linear);
  const durationSeconds = parseClock(textOf(childOf(linear, "Duration")));
  const clicks = childOf(linear, "VideoClicks");
  const hasClickThrough = !!clicks && !!childOf(clicks, "ClickThrough");

  return {
    ad: {
      id: (adNode.attrs.id ?? "").trim() || null,
      adSystem: textOf(childOf(inline, "AdSystem")) || null,
      durationSeconds,
      skipOffsetSeconds: parseSkipOffset(linear, durationSeconds),
      mediaFiles,
      impressionUrls,
      errorUrls,
      tracking: readTracking(linear),
      hasClickThrough,
    },
    reason: null,
  };
}

function fail(reason: VastFailureReason): VastParseResult {
  return { ok: false, reason };
}

/**
 * Parses a VAST response into linear ads that are safe to hand to a player.
 *
 * Returns `{ ok: false, reason }` — never throws — for anything it will not
 * play. Callers must treat every failure as "show no ad", never as "show
 * something plausible instead".
 */
export function parseVastResponse(xml: string): VastParseResult {
  if (typeof xml !== "string" || xml.trim().length === 0) return fail("empty");
  if (xml.length > MAX_VAST_XML_CHARS) return fail("oversized");

  // Reject DTDs outright (XXE / entity-expansion bait) before the scanner runs.
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) return fail("unsafe-markup");

  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    return fail("malformed");
  }

  if (root.name !== "VAST") return fail("malformed");

  const adNodes = childrenOf(root, "Ad");
  if (adNodes.length === 0) return fail("no-ad");

  const ads: VastLinearAd[] = [];
  let sawWrapper = false;
  let sawVpaid = false;

  for (const adNode of adNodes) {
    const inline = childOf(adNode, "InLine");
    if (!inline) {
      if (childOf(adNode, "Wrapper")) sawWrapper = true;
      continue;
    }

    const read = readInline(adNode, inline);
    if (read.ad) {
      ads.push(read.ad);
    } else if (read.reason === "vpaid-unsupported") {
      sawVpaid = true;
    }
  }

  if (ads.length > 0) return { ok: true, ads };

  // Precedence is about telling the truth in diagnostics: an unresolved wrapper
  // is the most important thing to know about a response we refused.
  if (sawWrapper) return fail("wrapper-unsupported");
  if (sawVpaid) return fail("vpaid-unsupported");

  const hadLinear = adNodes.some((adNode) => {
    const inline = childOf(adNode, "InLine");
    if (!inline) return false;
    return childrenOf(inline, "Creatives").some((creatives) =>
      childrenOf(creatives, "Creative").some(
        (creative) => childOf(creative, "Linear") !== null,
      ),
    );
  });

  return fail(hadLinear ? "no-media" : "no-linear");
}

/**
 * The single media file to play: MP4 first, then the highest bitrate.
 * Returns null when the ad has no playable file.
 */
export function pickMediaFile(ad: VastLinearAd): VastMediaFile | null {
  if (ad.mediaFiles.length === 0) return null;

  const score = (file: VastMediaFile): number => {
    const isMp4 = file.type === "video/mp4" ? 1_000_000 : 0;
    return isMp4 + (file.bitrate ?? 0) + (file.width ?? 0);
  };

  return [...ad.mediaFiles].sort((a, b) => score(b) - score(a))[0] ?? null;
}
