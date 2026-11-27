/**
 * Post-match VAST providers — adapter contract.
 *
 * The player stays the single foundation; these adapters only change where an
 * Inline ad comes from. The refusals matter more than the happy path:
 * wrappers, VPAID, unsafe URLs and malformed XML must all resolve to a typed
 * failure, never to something playable.
 *
 * Run: npm run test:vast-providers
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DEFAULT_VIDEO_TIMEOUT_MS,
  MAX_VIDEO_TIMEOUT_MS,
  MIN_VIDEO_TIMEOUT_MS,
  normalizeVideoTagUrl,
  videoAdsGloballyEnabled,
  videoProviderAllowsPlacement,
  videoTimeoutMs,
} from "../src/lib/vast/providers/config.ts";
import {
  VIDEO_PROVIDERS,
  VIDEO_PROVIDER_ORDER,
  requestVideoAd,
  videoProviderById,
} from "../src/lib/vast/providers/index.ts";
import { adcashVideoConfig } from "../src/lib/vast/providers/adcash.ts";
import { exoclickVideoConfig } from "../src/lib/vast/providers/exoclick.ts";
import { hilltopVideoConfig } from "../src/lib/vast/providers/hilltop.ts";
import { HILLTOPS_VAST_TAG } from "../src/lib/vast/config.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const COMPONENT = read("src/components/ads/PostMatchVideoAd.tsx");
const SLOT = read("src/components/ads/PostMatchAdSlot.tsx");
const DOCS = read("docs/vast-providers.md");

const EXO_TAG = "https://video.example/exoclick-vast.xml";
const ADCASH_TAG = "https://video.example/adcash-vast.xml";

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

let fetchCalls = 0;

/** Replace fetch with a deterministic XML responder. */
function stubFetch(xml, status = 200) {
  fetchCalls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    fetchCalls += 1;
    if (init.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return new Response(xml, { status });
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

/** Run `fn` with a temporary environment and always restore it. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN_ENV = {
  NEXT_PUBLIC_POST_MATCH_ADS_ENABLED: undefined,
  NEXT_PUBLIC_HILLTOPS_ENABLED: undefined,
  NEXT_PUBLIC_HILLTOPS_VAST_URL: undefined,
  NEXT_PUBLIC_HILLTOPS_VAST_TIMEOUT_MS: undefined,
  NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: undefined,
  NEXT_PUBLIC_EXOCLICK_VAST_TAG: undefined,
  NEXT_PUBLIC_EXOCLICK_VAST_TIMEOUT_MS: undefined,
  NEXT_PUBLIC_ADCASH_VAST_ENABLED: undefined,
  NEXT_PUBLIC_ADCASH_VAST_TAG: undefined,
  NEXT_PUBLIC_ADCASH_VAST_TIMEOUT_MS: undefined,
};

const SAMPLE = `<VAST version="3.0">
  <Ad id="1030628">
    <InLine>
      <AdSystem version="3.0">TestProvider</AdSystem>
      <Error><![CDATA[https://ads.example/err?code=[ERRORCODE]]]></Error>
      <Impression><![CDATA[https://ads.example/imp]]></Impression>
      <Impression><![CDATA[https://ads.example/imp]]></Impression>
      <Creatives>
        <Creative>
          <Linear skipoffset="00:00:15">
            <TrackingEvents>
              <Tracking event="start"><![CDATA[https://ads.example/start]]></Tracking>
              <Tracking event="start"><![CDATA[https://ads.example/start]]></Tracking>
              <Tracking event="complete"><![CDATA[https://ads.example/complete]]></Tracking>
              <Tracking event="skip"><![CDATA[https://ads.example/skip]]></Tracking>
              <Tracking event="midpoint"><![CDATA[https://ads.example/mid]]></Tracking>
            </TrackingEvents>
            <Duration>00:00:41</Duration>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" bitrate="1961" width="1280" height="720"><![CDATA[https://cdn.example/ad-720.mp4]]></MediaFile>
              <MediaFile delivery="progressive" type="video/webm" bitrate="1330" width="1280" height="720"><![CDATA[https://cdn.example/ad-720.webm]]></MediaFile>
            </MediaFiles>
            <VideoClicks>
              <ClickThrough><![CDATA[https://ads.example/click/secret-token]]></ClickThrough>
            </VideoClicks>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;

const WRAPPER = `<VAST version="3.0">
  <Ad id="w1"><Wrapper>
    <AdSystem>TestProvider</AdSystem>
    <VASTAdTagURI><![CDATA[https://evil.example/next.xml]]></VASTAdTagURI>
    <Impression><![CDATA[https://ads.example/imp]]></Impression>
  </Wrapper></Ad>
</VAST>`;

// ── Configuration ─────────────────────────────────────────────────────────

test("new providers are disabled until enabled AND configured", async () => {
  await withEnv(CLEAN_ENV, () => {
    assert.equal(videoAdsGloballyEnabled(), true, "the master switch defaults on");

    const hilltop = hilltopVideoConfig();
    assert.equal(hilltop.enabled, true, "Hilltop keeps its existing opt-out behaviour");
    assert.equal(hilltop.tagUrl, HILLTOPS_VAST_TAG);
    assert.equal(hilltop.configured, true);
    assert.equal(hilltop.placement, "post-match");

    for (const [config, id] of [
      [exoclickVideoConfig(), "exoclick"],
      [adcashVideoConfig(), "adcash"],
    ]) {
      assert.equal(config.id, id);
      assert.equal(config.enabled, false, `${id} is off by default`);
      assert.equal(config.tagUrl, null, `${id} has no default tag`);
      assert.equal(config.configured, false);
      assert.equal(config.placement, "post-match");
      assert.equal(config.timeoutMs, DEFAULT_VIDEO_TIMEOUT_MS);
    }
  });
});

test("a provider switch without a tag is still not configured", async () => {
  await withEnv(
    { ...CLEAN_ENV, NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true" },
    () => {
      const config = exoclickVideoConfig();
      assert.equal(config.enabled, true);
      assert.equal(config.configured, false);
      assert.equal(config.tagUrl, null);
    },
  );

  await withEnv(
    { ...CLEAN_ENV, NEXT_PUBLIC_ADCASH_VAST_ENABLED: "true", NEXT_PUBLIC_ADCASH_VAST_TAG: ADCASH_TAG },
    () => {
      const config = adcashVideoConfig();
      assert.equal(config.enabled, true);
      assert.equal(config.configured, true);
      assert.equal(config.tagUrl, ADCASH_TAG);
    },
  );
});

test("tags are https only, credential-free, and returned unmodified", async () => {
  assert.equal(normalizeVideoTagUrl(EXO_TAG), EXO_TAG);
  assert.equal(
    normalizeVideoTagUrl("//video.example/tag.xml?a=1&b=2"),
    "https://video.example/tag.xml?a=1&b=2",
  );

  for (const bad of [
    "http://video.example/tag.xml",
    "javascript:alert(1)",
    "https://user:pass@video.example/tag.xml",
    "not-a-url",
    "",
    null,
    "https://video.example/" + "a".repeat(2100),
  ]) {
    assert.equal(normalizeVideoTagUrl(bad), null, `${bad} must be refused`);
  }

  await withEnv(
    { ...CLEAN_ENV, NEXT_PUBLIC_EXOCLICK_VAST_TAG: "http://video.example/tag.xml" },
    () => {
      assert.equal(exoclickVideoConfig().tagUrl, null);
      assert.equal(exoclickVideoConfig().configured, false);
    },
  );
});

test("timeouts are bounded and the master kill switch disables every provider", async () => {
  assert.equal(videoTimeoutMs(undefined), DEFAULT_VIDEO_TIMEOUT_MS);
  assert.equal(videoTimeoutMs("50"), MIN_VIDEO_TIMEOUT_MS);
  assert.equal(videoTimeoutMs("99999"), MAX_VIDEO_TIMEOUT_MS);
  assert.equal(videoTimeoutMs("junk"), DEFAULT_VIDEO_TIMEOUT_MS);

  await withEnv(
    {
      ...CLEAN_ENV,
      NEXT_PUBLIC_POST_MATCH_ADS_ENABLED: "false",
      NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true",
      NEXT_PUBLIC_EXOCLICK_VAST_TAG: EXO_TAG,
    },
    () => {
      assert.equal(videoAdsGloballyEnabled(), false);
      assert.equal(hilltopVideoConfig().enabled, false);
      assert.equal(exoclickVideoConfig().enabled, false);
    },
  );
});

test("the registry exposes every adapter, and the player uses the chain", () => {
  assert.deepEqual([...VIDEO_PROVIDER_ORDER], [
    "hilltop",
    "exoclick",
    "adcash",
    "adexchange",
  ]);
  assert.deepEqual(VIDEO_PROVIDERS.map((provider) => provider.id), [
    "hilltop",
    "exoclick",
    "adcash",
    "adexchange",
  ]);
  assert.equal(videoProviderById("hilltop")?.id, "hilltop");
  assert.equal(videoProviderById("unknown"), null);

  // Phase 5 wires the same adapters through the sequential chain; the player
  // no longer requests one hard-coded tag.
  assert.match(COMPONENT, /videoProviderChain\(/);
  assert.match(COMPONENT, /runAdChain\(/);
  assert.match(COMPONENT, /requestVideoAd\(/);
  assert.ok(!/postMatchVastUrl\(\)/.test(COMPONENT));
  assert.ok(!/requestVastAds\(/.test(COMPONENT));
});

// ── Inline ads ────────────────────────────────────────────────────────────

test("every adapter normalizes a valid Inline ad for the existing player", async () => {
  for (const [id, env] of [
    ["hilltop", {}],
    ["exoclick", { NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true", NEXT_PUBLIC_EXOCLICK_VAST_TAG: EXO_TAG }],
    ["adcash", { NEXT_PUBLIC_ADCASH_VAST_ENABLED: "true", NEXT_PUBLIC_ADCASH_VAST_TAG: ADCASH_TAG }],
  ]) {
    await withEnv({ ...CLEAN_ENV, ...env }, async () => {
      stubFetch(SAMPLE);
      try {
        const result = await requestVideoAd(id);
        assert.equal(result.ok, true, `${id} must return a playable ad`);
        assert.equal(fetchCalls, 1);

        const ad = result.ad;
        assert.equal(ad.provider, id);
        assert.equal(ad.adId, "1030628");
        assert.equal(ad.adSystem, "TestProvider");
        assert.equal(ad.durationSeconds, 41);
        assert.equal(ad.skipOffsetSeconds, 15, "the provider hint is preserved");
        assert.equal(ad.media.type, "video/mp4");
        assert.equal(ad.media.url, "https://cdn.example/ad-720.mp4");

        assert.deepEqual(ad.impressionUrls, ["https://ads.example/imp"], "impressions are deduplicated");
        assert.deepEqual(ad.startUrls, ["https://ads.example/start"]);
        assert.deepEqual(ad.completeUrls, ["https://ads.example/complete"]);
        assert.deepEqual(ad.skipUrls, ["https://ads.example/skip"]);
        assert.deepEqual(ad.errorUrls, ["https://ads.example/err?code=[ERRORCODE]"]);

        assert.equal(ad.hasClickThrough, true);
        assert.ok(!("clickThroughUrl" in ad), "the click-through URL is never exposed");
        assert.ok(!JSON.stringify(ad).includes("secret-token"));
      } finally {
        restoreFetch();
      }
    });
  }
});

test("a served ad with no playable media resolves to no-media", async () => {
  await withEnv(
    { ...CLEAN_ENV, NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true", NEXT_PUBLIC_EXOCLICK_VAST_TAG: EXO_TAG },
    async () => {
      stubFetch(`<VAST version="3.0"><Ad id="x"><InLine>
        <Creatives><Creative><Linear>
          <Duration>00:00:10</Duration>
          <MediaFiles>
            <MediaFile delivery="progressive" type="video/mp4"><![CDATA[http://insecure.example/ad.mp4]]></MediaFile>
            <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://user:pass@cdn.example/ad.mp4]]></MediaFile>
            <MediaFile delivery="progressive" type="application/javascript" apiFramework="VPAID"><![CDATA[https://cdn.example/vpaid.js]]></MediaFile>
          </MediaFiles>
        </Linear></Creative></Creatives>
      </InLine></Ad></VAST>`);
      try {
        assert.deepEqual(await requestVideoAd("exoclick"), {
          ok: false,
          provider: "exoclick",
          reason: "no-media",
        });
      } finally {
        restoreFetch();
      }
    },
  );
});

test("VPAID-only creatives are refused, never executed", async () => {
  await withEnv(
    { ...CLEAN_ENV, NEXT_PUBLIC_ADCASH_VAST_ENABLED: "true", NEXT_PUBLIC_ADCASH_VAST_TAG: ADCASH_TAG },
    async () => {
      stubFetch(`<VAST version="3.0"><Ad id="v"><InLine>
        <Creatives><Creative><Linear>
          <MediaFiles>
            <MediaFile type="application/javascript" apiFramework="VPAID"><![CDATA[https://cdn.example/vpaid.js]]></MediaFile>
          </MediaFiles>
          <InteractiveCreativeFile type="application/javascript" apiFramework="VPAID"><![CDATA[https://cdn.example/vpaid.js]]></InteractiveCreativeFile>
        </Linear></Creative></Creatives>
      </InLine></Ad></VAST>`);
      try {
        assert.deepEqual(await requestVideoAd("adcash"), {
          ok: false,
          provider: "adcash",
          reason: "vpaid-unsupported",
        });
      } finally {
        restoreFetch();
      }
    },
  );
});

// ── Refused documents ─────────────────────────────────────────────────────

test("a Wrapper response is refused, never followed", async () => {
  await withEnv(
    { ...CLEAN_ENV, NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true", NEXT_PUBLIC_EXOCLICK_VAST_TAG: EXO_TAG },
    async () => {
      stubFetch(WRAPPER);
      try {
        assert.deepEqual(await requestVideoAd("exoclick"), {
          ok: false,
          provider: "exoclick",
          reason: "wrapper-unsupported",
        });
        assert.equal(fetchCalls, 1, "no second request is made");
      } finally {
        restoreFetch();
      }
    },
  );

  // The limitation is documented, and the parser was not weakened.
  assert.match(DOCS, /Wrapper/);
  assert.match(DOCS, /depth/i);
});

test("malformed XML, DTDs and empty responses fail closed", async () => {
  await withEnv(
    { ...CLEAN_ENV, NEXT_PUBLIC_ADCASH_VAST_ENABLED: "true", NEXT_PUBLIC_ADCASH_VAST_TAG: ADCASH_TAG },
    async () => {
      for (const [xml, reason] of [
        ["<VAST><Ad>", "malformed"],
        ["<!DOCTYPE VAST [<!ENTITY x >]><VAST></VAST>", "unsafe-markup"],
        ["", "empty"],
      ]) {
        stubFetch(xml);
        try {
          const result = await requestVideoAd("adcash");
          assert.equal(result.ok, false);
          assert.equal(result.reason, reason);
        } finally {
          restoreFetch();
        }
      }
    },
  );
});

// ── Transport, abort and tracking ─────────────────────────────────────────

test("provider failure and abort are typed, never thrown", async () => {
  await withEnv(
    { ...CLEAN_ENV, NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true", NEXT_PUBLIC_EXOCLICK_VAST_TAG: EXO_TAG },
    async () => {
      stubFetch("", 404);
      try {
        assert.deepEqual(await requestVideoAd("exoclick"), {
          ok: false,
          provider: "exoclick",
          reason: "http-error",
        });
      } finally {
        restoreFetch();
      }

      stubFetch(SAMPLE);
      try {
        const controller = new AbortController();
        controller.abort();
        const result = await requestVideoAd("exoclick", { signal: controller.signal });
        assert.deepEqual(result, { ok: false, provider: "exoclick", reason: "aborted" });
      } finally {
        restoreFetch();
      }
    },
  );
});

test("measurement URLs are held to the https rule", async () => {
  await withEnv(
    { ...CLEAN_ENV, NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true", NEXT_PUBLIC_EXOCLICK_VAST_TAG: EXO_TAG },
    async () => {
      stubFetch(`<VAST version="3.0"><Ad id="t"><InLine>
        <Impression><![CDATA[http://insecure.example/imp]]></Impression>
        <Error><![CDATA[javascript:alert(1)]]></Error>
        <Creatives><Creative><Linear>
          <Duration>00:00:10</Duration>
          <TrackingEvents>
            <Tracking event="start"><![CDATA[data:text/html,x]]></Tracking>
            <Tracking event="complete"><![CDATA[https://ads.example/done]]></Tracking>
          </TrackingEvents>
          <MediaFiles>
            <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://cdn.example/ad.mp4]]></MediaFile>
          </MediaFiles>
        </Linear></Creative></Creatives>
      </InLine></Ad></VAST>`);
      try {
        const result = await requestVideoAd("exoclick");
        assert.equal(result.ok, true);
        assert.deepEqual(result.ad.impressionUrls, []);
        assert.deepEqual(result.ad.errorUrls, []);
        assert.deepEqual(result.ad.startUrls, []);
        assert.deepEqual(result.ad.completeUrls, ["https://ads.example/done"]);
      } finally {
        restoreFetch();
      }
    },
  );
});

test("a disabled or unconfigured provider makes no request", async () => {
  await withEnv(CLEAN_ENV, async () => {
    stubFetch(SAMPLE);
    try {
      assert.deepEqual(await requestVideoAd("exoclick"), {
        ok: false,
        provider: "exoclick",
        reason: "disabled",
      });
      assert.equal(fetchCalls, 0);
    } finally {
      restoreFetch();
    }

    await withEnv(
      { NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true" },
      async () => {
        assert.deepEqual(await requestVideoAd("exoclick"), {
          ok: false,
          provider: "exoclick",
          reason: "not-configured",
        });
        assert.equal(fetchCalls, 0);
      },
    );
  });
});

// ── Placement and player policy ───────────────────────────────────────────

test("the only placement is post-match", () => {
  assert.equal(videoProviderAllowsPlacement("post-match"), true);
  for (const never of ["home", "hub", "leaderboard", "profile", "match", "lobby", "post-match-overlay"]) {
    assert.equal(videoProviderAllowsPlacement(never), false, `${never} is not a video placement`);
  }

  // The player still gates on a finished match, keeps its own 15 s skip rule,
  // and still guards impressions against duplicates.
  assert.match(COMPONENT, /matchEnded/);
  assert.match(COMPONENT, /export const SKIP_AFTER_SECONDS = 15;/);
  assert.match(COMPONENT, /impressionSentRef/);
  assert.match(COMPONENT, /if \(!active \|\| !matchEnded \|\| !offerAllowed\) return;/);

  // The shared slot still asks the server and only a result screen mounts it.
  assert.match(SLOT, /fetch\("\/api\/ads\/post-match"/);
  assert.match(SLOT, /surface\.adFree/);
});
