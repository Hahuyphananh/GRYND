# AdSense readiness — what the code does, what you still have to do, and the one risk code cannot fix

This is the operating note for monetising GRYND with Google AdSense. It is
deliberately blunt: everything that can be enforced in this repository already
is, and the rest is either a dashboard action or a product/policy decision.

---

## 1. What already exists in the code

| Requirement | Where it lives | Test that pins it |
| --- | --- | --- |
| AdSense loader in the served HTML (not injected after hydration) | `src/components/AdSenseScript.tsx` | `tests/adsense.test.mjs` |
| Publisher id, placements, per-placement unit ids, kill switch | `src/lib/ads.ts` (`DEFAULT_ADSENSE_PUBLISHER_ID`, `NEXT_PUBLIC_ADSENSE_*`) | `tests/ad-model.test.mjs` |
| Site-verification meta tag (`google-adsense-account`) | `src/app/layout.tsx` | `tests/adsense-readiness.test.mjs` |
| `ads.txt` DIRECT seller for the same publisher | `public/ads.txt` | `tests/adsense.test.mjs`, `tests/ad-model.test.mjs` |
| Consent Mode signals default to **denied** before any tag runs | `src/components/ConsentModeDefault.tsx` | `tests/adsense.test.mjs` |
| Google's certified CMP for EEA/UK/CH; own banner elsewhere (never both) | `src/lib/consentRegions.ts`, `src/components/CmpConsentBridge.tsx`, `src/components/CookieConsentBanner.tsx` | `tests/adsense.test.mjs` |
| Withdrawal as easy as consenting | `src/components/CookieSettingsLink.tsx` (footer link) | `tests/adsense.test.mjs` |
| Ad-free entitlement for GRYND PRO, enforced server-side | `src/lib/adEntitlement.ts`, `AdSlot`, `AdSenseScript` | `tests/ad-model.test.mjs`, `tests/ad-slot-gate.test.mjs` |
| Ads labelled "Advertisement" and never in gameplay | `src/components/AdSlot.tsx`, placement list in `src/lib/ads.ts` | `tests/ad-model.test.mjs` (scans every gameplay route) |
| Publisher statement / funding disclosure | `/about` | `tests/adsense-readiness.test.mjs` |
| Cookie + advertising disclosure with third-party opt-outs | `/cookie-policy` | `tests/adsense-readiness.test.mjs` |
| Original content surface for review | `/guides` + `/guides/<slug>` (12 articles), `/games/<slug>` rules pages, `/faq` | `tests/guides.test.mjs`, `tests/sitemap.test.mjs` |

### Where ads can appear

`home` (`/`), `hub` (`/games`), `leaderboard` (`/classement`), `profile`
(`/profil`), every game lobby, and `guides` (the guide index and every guide
article — the `guides` placement).

Never: any match/board route, any `/casino/<slug>/...` route below a lobby, and
the games whose lobby and the board share one URL. The match routes have no ad
code in their document at all, so a navigation from an ad-carrying page into a
match leaves the loader behind (`src/lib/matchNavigation.ts`,
`src/components/MatchEntryGuard.tsx`).

### Configuration

```
NEXT_PUBLIC_ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXXXXXX
NEXT_PUBLIC_ADSENSE_ENABLED=false            # optional master kill switch
NEXT_PUBLIC_ADSENSE_SLOT_HOME=<unit id>
NEXT_PUBLIC_ADSENSE_SLOT_HUB=<unit id>
NEXT_PUBLIC_ADSENSE_SLOT_LEADERBOARD=<unit id>
NEXT_PUBLIC_ADSENSE_SLOT_PROFILE=<unit id>
NEXT_PUBLIC_ADSENSE_SLOT_GUIDES=<unit id>
```

A placement with no unit id renders **nothing** — there are no placeholder unit
ids in the repository. Set the ids from the AdSense account (Ads → By ad unit →
Display ads), then redeploy: `NEXT_PUBLIC_*` values are baked in at build time.

---

## 2. What you must do in the AdSense dashboard (not automatable)

1. **Claim the site** (`Sites → Add site`) for `www.grynd.dedyn.io`, and pick a
   verification method. The repo already supports two:
   - `ads.txt` at the root (`public/ads.txt`, publisher `pub-4903728316211815`);
   - the `google-adsense-account` meta tag in `<head>`.
   If Google issued an HTML verification file and it is not
   `public/googlef8f96916596f5cbe.html`, drop the new file into `public/`.
2. **Enable a Google-certified CMP** (Privacy & messaging → European
   regulations → GDPR message) for the EEA, the UK and Switzerland. The code
   shows Google's message and mirrors its answer into the local consent record,
   but the *message itself* must be published in the AdSense account. Without
   it, EEA/UK/CH visitors get no prompt and no ads.
3. **Create the ad units** and put their ids in the `NEXT_PUBLIC_ADSENSE_SLOT_*`
   variables above.
4. **Check `ads.txt` resolves** at `https://www.grynd.dedyn.io/ads.txt` after
   deploying, and that AdSense reports it as authorised (no "Earnings at risk").
5. **Request a review** only after steps 1–4: the crawl must already find the
   loader, `ads.txt`, the policy pages and a populated content library.
6. **Do not click your own ads.** Use the AdSense preview/URL-channel tools to
   check a slot. Every unit and the loader load Google's own code; verifying a
   live impression by clicking it is the fastest way to lose the account.

---

## 3. The risk that code cannot fix: gambling-adjacent content

AdSense's Program policies require the site's content to comply with the Google
Publisher Policies. Gambling and casino-style content sits in the **restricted**
category: ad code is technically permitted on such pages, but ad demand is
limited and approval is frequently refused for sites whose primary purpose is
casino-style play. GRYND's exposure is real and should be treated as the main
risk to approval, not the ad implementation:

- the product grew out of a casino-style multi-game app and keeps `/casino/*`
  URLs, token balances and wager-era vocabulary in places;
- the games are free and there is no real money, which is the strongest part of
  the case, but a reviewer judges the *pages the ad code sits on*, not only the
  terms of service.

What the repository does to reduce it:

- ads are **never** on a board. Every ad-bearing page is a browsing or editorial
  page, which is the defensible inventory shape;
- every ad-bearing page states that GRYND is free, has no real-money wagering
  and no cash prizes (`/about`, `/cookie-policy`, `/terms`, `/fair-play`);
- the editorial layer (`/guides`) is genuine long-form content written in-house,
  linked from the footer and in the sitemap — the surface a reviewer reads to
  decide whether the site is a content site or a thin game shell.

What remains a **product decision** (not done here, because each changes the
product rather than the ad integration):

1. **Finish the solitaire-first narrowing.** The footer already presents GRYND
   as a Solitaire site; the casino-era routes and copy are the main reason a
   reviewer would classify the site as casino content. Retiring or noindexing
   the unused game routes and removing wager vocabulary is the highest-impact
   remaining change.
2. **Decide the fallback if the review is refused for gambling content.** The
   achievable path is to serve ads only on a non-wagering content site (guides,
   rules, FAQ, leaderboard explanations) and keep gameplay ad-free — i.e. finish
   the separation the ad model already started.

If a review is refused, do **not** create a second AdSense account or re-apply
from an alias domain; that is a policy violation that ends both accounts. Fix
the content classification first, then re-apply.

---

## 4. Verification commands

```bash
npx tsc --noEmit
npm run test:adsense        # loader/consent/ads.txt contracts + this checklist
npm run test:ads           # adds the behavioural ad-gate suite
npm run test:sitemap        # /about and /cookie-policy are in the inventory
```

The suites assert behaviour and wiring, not that Google approved the site. Site
approval is a human review and cannot be asserted from a test.
