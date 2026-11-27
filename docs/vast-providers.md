# Post-match VAST providers — compatibility, adapters and configuration

The post-match video surface keeps its existing foundation:

- `src/components/ads/PostMatchVideoAd.tsx` — the only player;
- `src/lib/vast/client.ts` — the bounded, credential-free follower;
- `src/lib/vast/parse.ts` — the strict parser;
- `src/lib/vast/frequency.ts` — cadence and per-match dedupe.

Phase 4 added the **adapters**; Phase 5 wires them into the same player through
the sequential fallback engine (`src/lib/ads/core/chain.ts`). There is still one
player, one post-match surface and one normalized result shape. The configured
priority is `NEXT_PUBLIC_ADS_VIDEO_ORDER`; a fill ends the chain, and a refused
provider falls through to the next.

## 1. What the parser accepts today

| Area | Behaviour |
| --- | --- |
| Root | `<VAST>` only; the `version` attribute is not checked, so VAST 2.0/3.0/4.x documents are accepted when their structure matches |
| Inline | `InLine → Creatives → Creative → Linear → MediaFiles` |
| Media | progressive `video/*`, no `apiFramework`, https with no credentials |
| Wrapper | **Refused** (`wrapper-unsupported`); `<VASTAdTagURI>` is never followed |
| VPAID / executable | **Refused** (`vpaid-unsupported`); `InteractiveCreativeFile` and `apiFramework` media dropped |
| Click-through | Detected but the URL is never returned |
| Tracking | Impression/Error and `Tracking` events are parsed; only https URLs survive |
| Markup | `<!DOCTYPE>`/`<!ENTITY>` rejected before parsing; size capped |

## 2. Provider tag inspection

Both new providers integrate through a **VAST tag URL** issued by their
publisher dashboard:

- ExoClick: video zone → VAST tag.
- Adcash: video zone → "In-stream video VAST tag URL integration".

**No live ExoClick or Adcash tag exists in this repository**, so this phase
cannot assert whether a particular account's tag answers with `<InLine>` or
`<Wrapper>`. That is per-account and per-demand behaviour, not a property of the
provider's name. The adapters are therefore Inline-only, and a Wrapper response
is reported as `wrapper-unsupported` rather than followed.

### Preflight before enabling a tag

Run the exact dashboard tag with a browser-like User-Agent and inspect the root:

```bash
curl -sS -A "Mozilla/5.0" "<TAG_URL>" | head -c 2000
# look for:   <VAST version="..."> <Ad> <InLine>
# not:        <Ad> <Wrapper> <VASTAdTagURI>
```

Accept the tag only if it returns `<InLine>` with a progressive `video/*`
`MediaFile`. If it returns `<Wrapper>`, either:

1. ask the provider for a tag/zone that returns Inline inventory, or
2. approve a separate bounded-wrapper phase. That phase must cap wrapper depth
   (≤ 2), total requests (≤ 3), accept only https destinations, forward abort
   signals, enforce a per-request timeout, detect loops by normalised URL, keep
   the existing media/tracking validation, and never execute VPAID or provider
   JavaScript.

Do **not** disable the parser's Wrapper refusal to make a tag fit.

## 3. Adapters

| Provider | Module | Default state |
| --- | --- | --- |
| HilltopAds | `src/lib/vast/providers/hilltop.ts` | Enabled as today, with the approved default tag and existing switches |
| ExoClick | `src/lib/vast/providers/exoclick.ts` | **Disabled**; no default tag |
| Adcash | `src/lib/vast/providers/adcash.ts` | **Disabled**; no default tag |

Every adapter returns the same normalized result
(`src/lib/vast/providers/types.ts`):

- provider id, ad id, ad system;
- the one playable media file (URL/type/size/bitrate);
- duration and the provider's skip hint;
- deduplicated impression and error URLs;
- deduplicated start, complete and skip tracking URLs;
- `hasClickThrough` only — **no click-through URL**.

Requests go through `requestWithConfig` → the existing `requestVastAds`, so
there is still one networking stack, one 512 KB cap, one timeout and one
in-flight guard.

## 4. Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_POST_MATCH_ADS_ENABLED` | on | Master switch; `false` disables every provider |
| `NEXT_PUBLIC_HILLTOPS_ENABLED` | on | Hilltop provider switch |
| `NEXT_PUBLIC_HILLTOPS_VAST_URL` | approved tag | Hilltop tag override |
| `NEXT_PUBLIC_HILLTOPS_VAST_TIMEOUT_MS` | 4000 | Clamped 1000–8000 |
| `NEXT_PUBLIC_EXOCLICK_VAST_ENABLED` | **off** | ExoClick VAST switch |
| `NEXT_PUBLIC_EXOCLICK_VAST_TAG` | none | **Required** before ExoClick can serve |
| `NEXT_PUBLIC_EXOCLICK_VAST_TIMEOUT_MS` | 4000 | Clamped 1000–8000 |
| `NEXT_PUBLIC_ADCASH_VAST_ENABLED` | **off** | Adcash VAST switch |
| `NEXT_PUBLIC_ADCASH_VAST_TAG` | none | **Required** before Adcash can serve |
| `NEXT_PUBLIC_ADCASH_VAST_TIMEOUT_MS` | 4000 | Clamped 1000–8000 |

The server-side kill switch `POST_MATCH_ADS_ENABLED` (read by
`/api/ads/post-match`) continues to gate the whole surface, and GRYND PRO
members still receive `enabled: false`.

Never put an API key, password or dashboard credential in a `NEXT_PUBLIC_*`
variable. Tag URLs are public (they appear in the request), but account access
is not.

## 5. What is intentionally not done

- No wrapper resolver and no VPAID support. A Wrapper/VPAID response is
  `invalid_response`, which falls through to the next provider.
- No revenue is reported. These providers expose no authoritative revenue feed
  to this app, and an estimate would be fabricated.
- `VIDEO_PROVIDER_ORDER` remains the default priority list; the live chain reads
  `NEXT_PUBLIC_ADS_VIDEO_ORDER` and filters it to enabled/configured adapters.

See `docs/ad-fallback.md` for the shared chain, opportunity dedupe, banner
fill-detection limits and the full test matrix.
