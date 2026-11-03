// tests/vast-post-match.test.mjs
//
// Contract guard for the post-match video ad. Two halves:
//
//   1. PARSER BEHAVIOUR — the response is untrusted third-party XML, so the
//      refusals matter more than the happy path: wrappers, VPAID/executable
//      creatives, DTDs, non-https media and malformed documents must all resolve
//      to "no ad", never to something playable.
//
//   2. SURFACE CONTRACTS — the component must load nothing until activated, must
//      never be able to navigate, must clean up after itself, and must not be
//      wired into any game or layout yet.
//
// Run: npm run test:vast

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, relative, sep } from "node:path";

import { parseVastResponse, pickMediaFile } from "../src/lib/vast/parse.ts";
import {
  HILLTOPS_VAST_TAG,
  postMatchAdsEnabled,
  postMatchVastUrl,
} from "../src/lib/vast/config.ts";

const read = (path) => fs.readFileSync(path, "utf8");

/** Assertions test CODE, not the prose that explains it. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const COMPONENT = read("src/components/ads/PostMatchVideoAd.tsx");
const CLIENT = read("src/lib/vast/client.ts");
const PARSER = read("src/lib/vast/parse.ts");
const CONFIG = read("src/lib/vast/config.ts");

/** A trimmed, representative copy of the approved HilltopAds response shape. */
const SAMPLE = `<VAST version="3.0" xmlns="http://www.w3.org/2001/XMLSchema">
  <Ad id="1030628">
    <InLine>
      <AdSystem version="3.0">HilltopAds</AdSystem>
      <Error><![CDATA[https://rude-movie.com/err?code=[ERRORCODE]]]></Error>
      <Impression><![CDATA[https://rude-movie.com/imp]]></Impression>
      <Creatives>
        <Creative>
          <Linear skipoffset="00:00:15">
            <TrackingEvents>
              <Tracking event="start"><![CDATA[https://rude-movie.com/start]]></Tracking>
              <Tracking event="complete"><![CDATA[https://rude-movie.com/complete]]></Tracking>
              <Tracking event="skip"><![CDATA[https://rude-movie.com/skip]]></Tracking>
            </TrackingEvents>
            <Duration>00:00:41</Duration>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" bitrate="1961" width="1280" height="720" codec="h264"><![CDATA[https://cdn.example/ad-720.mp4]]></MediaFile>
              <MediaFile delivery="progressive" type="video/webm" bitrate="1330" width="1280" height="720" codec="vp9"><![CDATA[https://cdn.example/ad-720.webm]]></MediaFile>
              <MediaFile delivery="progressive" type="video/mp4" bitrate="717" width="640" height="360" codec="h264"><![CDATA[https://cdn.example/ad-360.mp4]]></MediaFile>
            </MediaFiles>
            <VideoClicks>
              <ClickThrough><![CDATA[https://rude-movie.com/click/secret-token]]></ClickThrough>
            </VideoClicks>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;

test("parses the approved response into a playable linear ad", () => {
  const result = parseVastResponse(SAMPLE);
  assert.equal(result.ok, true);

  const ad = result.ads[0];
  assert.equal(ad.id, "1030628");
  assert.equal(ad.adSystem, "HilltopAds");
  assert.equal(ad.durationSeconds, 41);
  assert.equal(ad.skipOffsetSeconds, 15);
  assert.deepEqual(ad.impressionUrls, ["https://rude-movie.com/imp"]);
  assert.deepEqual(ad.errorUrls, ["https://rude-movie.com/err?code=[ERRORCODE]"]);
  assert.deepEqual(
    ad.tracking.map((item) => item.event),
    ["start", "complete", "skip"],
  );

  // MP4 preferred, then the highest bitrate.
  const picked = pickMediaFile(ad);
  assert.equal(picked.type, "video/mp4");
  assert.equal(picked.url, "https://cdn.example/ad-720.mp4");
});

test("a click-through is recorded but never exposed as a URL", () => {
  const result = parseVastResponse(SAMPLE);
  const ad = result.ads[0];

  assert.equal(ad.hasClickThrough, true, "the response does carry a click-through");
  assert.ok(
    !("clickThroughUrl" in ad),
    "the player must have no click-through URL to bind",
  );
  assert.ok(
    !JSON.stringify(ad).includes("secret-token"),
    "the click-through target must not survive parsing",
  );
});

test("a wrapper response is refused, never resolved", () => {
  const result = parseVastResponse(`<VAST version="3.0">
    <Ad id="w1"><Wrapper>
      <AdSystem>HilltopAds</AdSystem>
      <VASTAdTagURI><![CDATA[https://evil.example/next.xml]]></VASTAdTagURI>
      <Impression><![CDATA[https://rude-movie.com/imp]]></Impression>
    </Wrapper></Ad>
  </VAST>`);

  assert.deepEqual(result, { ok: false, reason: "wrapper-unsupported" });
});

test("a VPAID-only creative is refused rather than executed", () => {
  const result = parseVastResponse(`<VAST version="3.0">
    <Ad id="v1"><InLine>
      <AdSystem>HilltopAds</AdSystem>
      <Creatives><Creative>
        <Linear>
          <Duration>00:00:20</Duration>
          <MediaFiles>
            <MediaFile delivery="progressive" type="application/javascript" apiFramework="VPAID"><![CDATA[https://evil.example/vpaid.js]]></MediaFile>
          </MediaFiles>
          <InteractiveCreativeFile type="application/javascript" apiFramework="VPAID"><![CDATA[https://evil.example/vpaid.js]]></InteractiveCreativeFile>
        </Linear>
      </Creative></Creatives>
    </InLine></Ad>
  </VAST>`);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "vpaid-unsupported");
});

test("a VPAID file is ignored when a progressive MP4 is present", () => {
  const result = parseVastResponse(`<VAST version="3.0">
    <Ad id="mix"><InLine>
      <AdSystem>HilltopAds</AdSystem>
      <Creatives><Creative>
        <Linear>
          <Duration>00:00:30</Duration>
          <MediaFiles>
            <MediaFile delivery="progressive" type="application/javascript" apiFramework="VPAID"><![CDATA[https://evil.example/vpaid.js]]></MediaFile>
            <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://cdn.example/real.mp4]]></MediaFile>
          </MediaFiles>
        </Linear>
      </Creative></Creatives>
    </InLine></Ad>
  </VAST>`);

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.ads[0].mediaFiles.map((file) => file.url),
    ["https://cdn.example/real.mp4"],
  );
});

test("non-https, credentialed and non-video media are dropped", () => {
  const result = parseVastResponse(`<VAST version="3.0">
    <Ad id="bad"><InLine>
      <AdSystem>HilltopAds</AdSystem>
      <Creatives><Creative>
        <Linear>
          <MediaFiles>
            <MediaFile delivery="progressive" type="video/mp4"><![CDATA[http://insecure.example/ad.mp4]]></MediaFile>
            <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://user:pass@cdn.example/ad.mp4]]></MediaFile>
            <MediaFile delivery="progressive" type="video/mp4"><![CDATA[javascript:alert(1)]]></MediaFile>
            <MediaFile delivery="progressive" type="text/html"><![CDATA[https://cdn.example/ad.mp4]]></MediaFile>
            <MediaFile delivery="streaming" type="video/mp4"><![CDATA[https://cdn.example/live.mp4]]></MediaFile>
          </MediaFiles>
        </Linear>
      </Creative></Creatives>
    </InLine></Ad>
  </VAST>`);

  assert.deepEqual(result, { ok: false, reason: "no-media" });
});

test("diagnostics URLs are held to the same https rule", () => {
  const result = parseVastResponse(`<VAST version="3.0">
    <Ad id="t"><InLine>
      <Impression><![CDATA[javascript:alert(1)]]></Impression>
      <Impression><![CDATA[http://insecure.example/pixel]]></Impression>
      <Error><![CDATA[https://rude-movie.com/err]]></Error>
      <Creatives><Creative><Linear>
        <Duration>00:00:10</Duration>
        <TrackingEvents>
          <Tracking event="start"><![CDATA[data:text/html,<script>alert(1)</script>]]></Tracking>
          <Tracking event="complete"><![CDATA[https://rude-movie.com/done]]></Tracking>
        </TrackingEvents>
        <MediaFiles>
          <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://cdn.example/ad.mp4]]></MediaFile>
        </MediaFiles>
      </Linear></Creative></Creatives>
    </InLine></Ad>
  </VAST>`);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ads[0].impressionUrls, []);
  assert.deepEqual(result.ads[0].errorUrls, ["https://rude-movie.com/err"]);
  assert.deepEqual(
    result.ads[0].tracking.map((item) => item.url),
    ["https://rude-movie.com/done"],
  );
});

test("a DTD is refused before parsing", () => {
  const result = parseVastResponse(
    `<!DOCTYPE VAST [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><VAST version="3.0"></VAST>`,
  );
  assert.deepEqual(result, { ok: false, reason: "unsafe-markup" });
});

test("malformed and empty documents fail closed", () => {
  assert.deepEqual(parseVastResponse(""), { ok: false, reason: "empty" });
  assert.deepEqual(parseVastResponse("   \n "), { ok: false, reason: "empty" });
  assert.deepEqual(parseVastResponse("<VAST><Ad>"), { ok: false, reason: "malformed" });
  assert.deepEqual(parseVastResponse("<html><body>blocked</body></html>"), {
    ok: false,
    reason: "malformed",
  });
  assert.deepEqual(parseVastResponse("<VAST version=\"3.0\"></VAST>"), {
    ok: false,
    reason: "no-ad",
  });
});

test("an oversized document is refused", () => {
  const result = parseVastResponse(`<VAST>${" ".repeat(300 * 1024)}</VAST>`);
  assert.deepEqual(result, { ok: false, reason: "oversized" });
});

test("a companion-only creative is not a video ad", () => {
  const result = parseVastResponse(`<VAST version="3.0">
    <Ad id="c"><InLine>
      <AdSystem>HilltopAds</AdSystem>
      <Creatives><Creative>
        <CompanionAds><Companion width="300" height="250">
          <StaticResource><![CDATA[https://cdn.example/banner.png]]></StaticResource>
        </Companion></CompanionAds>
      </Creative></Creatives>
    </InLine></Ad>
  </VAST>`);

  assert.deepEqual(result, { ok: false, reason: "no-linear" });
});

test("a percentage skip offset resolves against the duration", () => {
  const result = parseVastResponse(`<VAST version="3.0">
    <Ad id="p"><InLine>
      <Creatives><Creative><Linear skipoffset="25%">
        <Duration>00:00:40</Duration>
        <MediaFiles>
          <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://cdn.example/ad.mp4]]></MediaFile>
        </MediaFiles>
      </Linear></Creative></Creatives>
    </InLine></Ad>
  </VAST>`);

  assert.equal(result.ok, true);
  assert.equal(result.ads[0].skipOffsetSeconds, 10);
});

test("CDATA and predefined entities decode to plain values", () => {
  const result = parseVastResponse(`<VAST version="3.0">
    <Ad id="e"><InLine>
      <AdSystem>Hilltop &amp; Co</AdSystem>
      <Creatives><Creative><Linear>
        <Duration>00:00:05</Duration>
        <MediaFiles>
          <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://cdn.example/ad.mp4?a=1&b=2]]></MediaFile>
        </MediaFiles>
      </Linear></Creative></Creatives>
    </InLine></Ad>
  </VAST>`);

  assert.equal(result.ok, true);
  assert.equal(result.ads[0].adSystem, "Hilltop & Co");
  assert.equal(result.ads[0].mediaFiles[0].url, "https://cdn.example/ad.mp4?a=1&b=2");
});

// ── Surface contracts ───────────────────────────────────────────────────────

test("the component plays itself, over the whole page", () => {
  const source = code(COMPONENT);
  assert.match(source, /"use client"/);
  // The offer itself starts the ad: there is no click-to-play step left.
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(!active \|\| !matchEnded \|\| !offerAllowed\) return;\s*void activate\(\);/,
    "the surface requests the tag on its own, once an offer is allowed",
  );
  assert.ok(!/Watch video/.test(source), "there is no manual play step");
  assert.match(source, /fixed inset-0 z-\[100\]/, "the ad takes the whole viewport");
  assert.match(source, /role="dialog"/);
  // Muted autoplay is what makes an automatic start work under every policy.
  assert.match(source, /autoPlay/);
  assert.match(source, /muted=\{muted\}/);
  // No tag is loaded at module scope either.
  assert.ok(
    !/fetch\(/.test(code(CONFIG)),
    "the config module must not make requests",
  );
  assert.ok(
    !/<script/i.test(source) && !/next\/script/.test(source),
    "no advertising code may be injected into the document",
  );
});

test("the skip control opens at 15 s for a long ad, and at its end for a short one", () => {
  const source = code(COMPONENT);
  assert.match(source, /export const SKIP_AFTER_SECONDS = 15;/);
  assert.match(
    source,
    /videoDuration !== null && videoDuration <= SKIP_AFTER_SECONDS\s*\?\s*videoDuration\s*:\s*SKIP_AFTER_SECONDS/,
    "a long creative unlocks at 15 s; a shorter one at its own end",
  );
  // The wait is the PLAYING clock: a paused or stalled ad earns no skip.
  assert.match(source, /onTimeUpdate=/);
  assert.match(source, /playedSeconds >= skipUnlockSeconds/);
  assert.match(source, /Skip in \$\{skipRemaining\}s/, "the wait is shown, not silent");
  // The overlay exists only while a creative is on screen, so there is no
  // loading or failure card the 15 s rule could trap the player behind.
  assert.doesNotMatch(source, /aria-label="Close advertisement"/);
  assert.ok(
    !/setTimeout\([^)]*dismiss/.test(source),
    "a mount timer must never end an ad",
  );
});

test("the component cannot navigate, redirect or open a window", () => {
  const source = code(COMPONENT);
  for (const forbidden of [
    "window.open",
    "location.assign",
    "location.replace",
    "location.href",
    "target=\"_blank\"",
    "<a ",
    "onClick={() => window",
    "dangerouslySetInnerHTML",
    "document.write",
  ]) {
    assert.ok(!source.includes(forbidden), `${forbidden} must never appear in the ad surface`);
  }

  // Click-through is not even available to bind.
  assert.ok(
    !/clickThroughUrl|clickthrough/i.test(source),
    "the component must not reference the click-through at all",
  );
  assert.match(
    code(PARSER),
    /hasClickThrough/,
    "the parser records its presence for tests only",
  );
});

test("nothing is drawn until a creative is ready, and never fake media", () => {
  const source = code(COMPONENT);
  // The wait for the tag is invisible: no loading overlay, no black screen.
  assert.doesNotMatch(source, /Loading advertisement…/);
  assert.doesNotMatch(source, /role="status"/);
  assert.doesNotMatch(source, /aria-live=/);
  assert.match(
    source,
    /if \(!active \|\| !matchEnded \|\| !offerAllowed \|\| phase !== "ready" \|\| !media\)/,
    "the overlay only mounts once a playable creative exists",
  );
  assert.doesNotMatch(
    source,
    /No advertisement is available right now\./,
    "an unavailable ad must never be left as a card to dismiss",
  );
  assert.doesNotMatch(
    source,
    /This video could not be played\./,
    "a creative that fails to play is removed, not explained on screen",
  );
  assert.doesNotMatch(source, /role="alert"/, "nothing is left behind to announce");
  // No stand-in creative of any kind.
  assert.ok(
    !/placeholder.*\.mp4|sample.*\.mp4|fallback.*src=/i.test(source),
    "a failed tag must never be replaced with invented video content",
  );
});

test("an unavailable ad is removed immediately, never left on screen", () => {
  const source = code(COMPONENT);

  // Every no-ad path — a missing tag URL, a refused/failed/timed-out request,
  // a response with no playable creative, or a creative the browser cannot
  // play — closes the surface at once.
  assert.equal(
    (source.match(/removeNow\(\);/g) ?? []).length,
    4,
    "each no-ad path must remove the surface immediately",
  );

  const removal = source.match(
    /const removeNow = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/,
  );
  assert.ok(removal, "removal must be one callback");
  assert.match(removal[0], /setPhase\("closed"\)/, "the overlay is closed, not re-labelled");
  assert.match(
    removal[0],
    /onNoOfferRef\.current\?\.\(\);/,
    "the host is told, so a held exit action can run",
  );
  // Nothing played, so this is not a dismissal and not a skip.
  assert.ok(
    !/markPostMatchAdDismissed|fireTracking/.test(removal[0]),
    "a removed ad must not be recorded as dismissed or skipped",
  );

  // A served creative that fails to play is cleared the same way: the 405 is
  // reported to the network, then the surface goes — no "could not be played"
  // card is left over the result.
  assert.match(source, /fireTracking\(ad\.errorUrls, "405"\);\s*removeNow\(\);/);

  // Removal leaves nothing behind: the overlay only exists with a creative,
  // so there is no loading screen and no card left to close.
  assert.match(source, /phase !== "ready"/);
  assert.doesNotMatch(source, /aria-label="Close advertisement"/);
});

test("the surface is labelled as an advertisement and carries a skip control", () => {
  const source = code(COMPONENT);
  assert.match(source, /aria-label="Advertisement"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-label=\{\s*canSkip \? "Skip advertisement"/, "playback has a skip control");
  assert.match(source, /data-post-match-ad=\{phase\}/);
});

test("the surface is gated on a finished match", () => {
  const source = code(COMPONENT);
  assert.match(source, /matchEnded/);
  assert.match(
    source,
    /if \(!active \|\| !matchEnded \|\| !offerAllowed \|\| phase !== "ready" \|\| !media\)/,
    "an active match, a declined offer, or an ad that is not ready must render nothing",
  );
});

test("one request at a time, and only one per component instance", () => {
  assert.match(code(CLIENT), /let inFlight: AbortController \| null = null/);
  assert.match(code(CLIENT), /if \(inFlight\) return \{ ok: false, reason: "busy" \}/);
  assert.match(code(COMPONENT), /requestStartedRef\.current/, "re-entry is refused locally");
  assert.match(
    code(COMPONENT),
    /if \(requestStartedRef\.current\) return;/,
    "a second activation must not issue a second request",
  );
});

test("the request is bounded, anonymous and cancellable", () => {
  const source = code(CLIENT);
  assert.match(source, /credentials: "omit"/, "the ad request is never authenticated");
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /DEFAULT_TIMEOUT_MS/, "a hung request must time out");
  const deadlineMs = Number(
    (source.match(/DEFAULT_TIMEOUT_MS = ([\d_]+)/) ?? [])[1]?.replace(/_/g, ""),
  );
  assert.ok(
    deadlineMs > 0 && deadlineMs <= 4_000,
    "the deadline is the player's worst-case wait to leave, so it must stay short",
  );
  assert.match(source, /AbortController/);
  assert.match(source, /MAX_RESPONSE_BYTES/, "the response is size-capped");
  assert.ok(!/eval\(|new Function/.test(source + code(PARSER)), "no dynamic code execution");
});

test("the player is torn down on unmount", () => {
  const source = code(COMPONENT);
  assert.match(source, /abortRef\.current\?\.abort\(\)/);
  assert.match(source, /removeAttribute\("src"\)/, "the media source is released");
  assert.match(source, /video\.load\(\)/, "the element is reset, not just detached");
  assert.match(source, /return \(\) => \{/, "cleanup is registered on unmount");
});

test("the approved tag is configuration, and malformed values are refused", () => {
  assert.equal(
    HILLTOPS_VAST_TAG,
    "https://rude-movie.com/dQmLF.zNdWGBNlv/Z_GzUa/Detmq9Ju_ZjUElLkiPrTWcJ1PNejfUfz_O/DbUjtYNUzgU/2WNOTrMj4ZOMQu",
  );
  assert.equal(postMatchVastUrl(), HILLTOPS_VAST_TAG);
  assert.equal(typeof postMatchAdsEnabled(), "boolean");

  const previous = process.env.NEXT_PUBLIC_HILLTOPS_VAST_URL;
  try {
    for (const bad of [
      "javascript:alert(1)",
      "http://rude-movie.com/insecure",
      "https://user:pass@rude-movie.com/x",
      "not-a-url",
      "",
    ]) {
      process.env.NEXT_PUBLIC_HILLTOPS_VAST_URL = bad;
      assert.equal(postMatchVastUrl(), null, `${bad} must be refused`);
    }
    process.env.NEXT_PUBLIC_HILLTOPS_VAST_URL = "https://ads.example/tag.xml";
    assert.equal(postMatchVastUrl(), "https://ads.example/tag.xml");
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HILLTOPS_VAST_URL;
    else process.env.NEXT_PUBLIC_HILLTOPS_VAST_URL = previous;
  }
});

test("the surface is mounted only by the wired result screens", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsx?|tsx?)$/.test(entry.name) && /PostMatchVideoAd/.test(read(full))) {
        offenders.push(relative(process.cwd(), full).split(sep).join("/"));
      }
    }
  };
  walk("src/app");

  // An explicit list, not "any file": mounting this on a browsing page, a
  // lobby or the shared layout would advertise outside a finished match. The
  // Tic-Tac-Toe pilot is a settled PvP duel; Barrier Blitz practice is a
  // finished single-player board. Every other game still has NO ad.
  assert.deepEqual(
    offenders,
    [],
    "no page mounts the player directly: every finished match uses the shared slot",
  );
  assert.ok(
    !/PostMatchVideoAd/.test(read("src/app/layout.tsx")),
    "nothing advertising may be mounted globally",
  );
  // Every other game reaches the same player through the ONE shared slot,
  // which asks the server first and never renders on a browsing page.
  assert.match(
    read("src/components/result/PvpResultScreen.jsx"),
    /<PostMatchAdSlot onDone=\{handleAdSettled\} \/>/,
    "the shared result screen is the single wiring point for every game",
  );
});
