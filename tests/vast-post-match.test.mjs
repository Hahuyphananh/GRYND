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

test("the component loads the tag only after an explicit activation", () => {
  const source = code(COMPONENT);
  assert.match(source, /"use client"/);
  assert.match(source, /onClick=\{\(\) => void activate\(\)\}/, "a click starts the request");
  assert.match(source, /requestVastAds\(/, "the request is what activation triggers");
  assert.ok(
    !/useEffect\([^)]*requestVastAds/.test(source),
    "nothing may fetch on mount — activation is a click, not an effect",
  );
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

test("the component shows loading and graceful error states, never fake media", () => {
  const source = code(COMPONENT);
  assert.match(source, /Loading advertisement…/, "a loading state is required");
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /role="alert"/, "a failure is announced, not silent");
  assert.match(source, /No advertisement is available right now\./);
  assert.match(source, /This video could not be played\./);
  // No stand-in creative of any kind.
  assert.ok(
    !/placeholder.*\.mp4|sample.*\.mp4|fallback.*src=/i.test(source),
    "a failed tag must never be replaced with invented video content",
  );
});

test("a close control always exists, and the card is labelled as an ad", () => {
  const source = code(COMPONENT);
  assert.match(source, /aria-label="Advertisement"/);
  assert.match(source, /aria-label="Close advertisement"/);
  assert.match(source, /const closeButton =/, "every phase renders the close control");
});

test("the surface is gated on a finished match", () => {
  const source = code(COMPONENT);
  assert.match(source, /matchEnded/);
  assert.match(
    source,
    /if \(!active \|\| !matchEnded \|\| !offerAllowed \|\| phase === "dismissed"\)/,
    "an active match — or a match the offer policy declined — must render nothing",
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

test("the surface is mounted only by the Tic-Tac-Toe pilot", () => {
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

  assert.deepEqual(
    offenders,
    ["src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx"],
    "the ad is enabled for exactly one pilot game",
  );
  assert.ok(
    !/PostMatchVideoAd/.test(read("src/app/layout.tsx")),
    "nothing advertising may be mounted globally",
  );
});
