# Play Console submission runbook

Field-by-field, in the order Play Console asks for it. Companion to
`docs/play-store-listing.md` (the copy to paste) and
`docs/play-data-safety-form.md` (the form answers).

Do these in order: the console will not let you publish a release until every
"App content" section is green, and several answers depend on the build you
uploaded.

---

## 0. Before you touch the console

- [ ] **Website deployed with the native gates live.** AdSense, the Hilltop
      banner, the post-match video and Stripe checkout are all decided on the
      server from the app's User-Agent. They take effect on deploy — not on app
      update — so deploy first, or reviewer devices will see ads and checkout
      that the listing says do not exist.
- [ ] **A signed AAB exists** (`grynd-<versionName>-<versionCode>-<sha>.aab`) and
      `jarsigner -verify` says `jar verified`.
- [ ] `npm run test:native-ads`, `npm run test:ads`, `npm run test:coin-checkout`
      pass — these are what the Ads/Purchases answers rest on.
- [ ] `/account-deletion` and `/privacy-policy` are reachable **signed out**.
- [ ] A **reviewer account** exists: verified 18+, no payment method, password
      set. Fill its address into the reviewer notes.

## 1. Developer account

1. Play Console → sign up, pay the one-time fee, complete identity verification.
2. If this is a **personal** account created after 13 Nov 2023, production is
   gated behind closed testing: **12 testers opted in for 14 continuous days**.
   Organization accounts are exempt — confirm which yours is, because it is the
   longest lead-time item in this document.

## 2. Create the app

| Field | Value |
|---|---|
| App name | `GRYND` |
| Default language | English (US) |
| App or game | Game |
| Free or paid | Free |
| Declarations | Tick both (Play policies, US export laws) |

**The package name `com.grynd.app` is permanent.** It cannot be changed after
the first upload; a different one means a new listing and no installs carried
over.

## 3. Upload the first bundle

1. **Testing → Internal testing → Create new release.**
2. Upload the `.aab`. The first upload is where Play asks you to enrol in **Play
   App Signing** — accept it (it makes a lost upload key recoverable).
3. Release notes: paste the "What's new" block from the listing doc.
4. Add yourself as an internal tester, install from the opt-in link, and play one
   ranked game, one daily challenge and one practice match on a real device.
   Confirm: no ads anywhere, and tapping the GRYND PRO / coin buttons refuses
   the purchase instead of opening Stripe.

Do not roll out to closed testing until that check passes — it is much cheaper
to fix now.

## 4. App content (every row must be green)

### 4.1 Privacy policy

`https://www.grynd.dedyn.io/privacy-policy`

### 4.2 Ads

**No.** All three ad surfaces are gated off in the app (`AdSenseScript`,
`AdSlot`, `HilltopBanner`, `GET /api/ads/post-match`), and
`npm run test:native-ads` fails if a gate is removed. If that answer ever
changes, this field must change with it.

### 4.3 Content rating (IARC questionnaire)

- Category: **Game**.
- **Simulated gambling**: yes — coins are wagered, but they are virtual credits
  with no cash value and cannot be redeemed. This is the answer that drives the
  rating.
- Violence, sexuality, profanity, drugs, horror: no.
- User-generated content: **yes** — chat, reviews, player reports. Say yes: it
  carries a moderation obligation you already meet (chat, reports, admin audit
  logs).
- Shares location: no. Purchases: no in-app purchases.
- Resulting rating must be **18+ / Mature** to match the app's own age gate.

### 4.4 Target audience

18 and over, **not** child-directed. Do not join the Families programme. The
answer here must agree with the content rating and with the app's age
verification.

### 4.5 Data safety

Work through `docs/play-data-safety-form.md` directly — it is written as the
form, in order, with the per-row questions answered.

Key answers: collected **and** shared (analytics/Sentry/Clerk as processors),
encrypted in transit and at rest, deletion available, **data not sold**.

### 4.6 App access

**All or some functionality is restricted.** Paste the reviewer credentials block
from `docs/play-store-listing.md`. This is the single most common reason a
working app gets rejected: a reviewer who cannot sign in has nothing to review.

### 4.7 Financial features

Declare the coin system honestly: virtual currency, purchased **on the website
only**, no in-app purchases, no cash value, no redemption, no real-money
gambling, no lending. If Play asks for a gambling licence, the answer is that
this is simulated gambling with virtual chips — and that is a position worth
taking advice on before you submit, not after.

### 4.8 Account deletion

`https://www.grynd.dedyn.io/account-deletion` — public, no sign-in, footer-linked,
with the in-app path and an assisted path for locked-out users.

### 4.9 Remaining declarations

Government app: no. News app: no. COVID tracing: no. Data safety independently
validated: n/a.

## 5. Store listing

1. Copy everything from `docs/play-store-listing.md`.
2. Upload the icon (`public/icon-512.png`), the feature graphic
   (`play-store/feature-graphic.jpg`) and the five screenshots
   (`play-store/screenshots/*.jpg`).
3. Category **Games → Card**; tags Solitaire / Card game / Strategy.
4. Contact email — the address `/contact` delivers to.
5. Save, then check the preview on a phone viewport before submitting.

## 6. Tracks

| Track | Purpose | Gate |
|---|---|---|
| Internal | Your own device, minutes | none |
| Closed | 12+ testers, feedback | required for personal accounts (14 days) |
| Production | Public | all App content green + review |

Promote by creating a release from the previous bundle in the next track — do
not rebuild; the same AAB is promoted, so the tested artifact is the shipped one.

## 7. Review notes

Paste the "Notes for reviewers" block. It answers the two questions a reviewer
forms immediately: *is this just a website?* (no — back button, edge-to-edge
insets, keyboard handling, haptics, splash, offline recovery, single permission)
and *what can I actually do?* (sign in with the credentials, play ranked,
practice and the daily challenge).

## 8. After submission

- Watch **Pre-launch report** — it runs on real devices and surfaces WebView
  problems you cannot reproduce locally.
- Expect 1–7 days for review; a rejection names a policy, so check the matching
  section above first.
- Keep `versionCode` moving forward forever: a rejected or rolled-back release
  still consumes its code.

## 9. Rejection playbook

| Likely reason | Where it is answered |
|---|---|
| "App is a website / minimum functionality" | Review notes: native integrations + the gated native-only experience |
| "Cannot access app" | App access credentials (4.6) |
| "Ads not declared" | Ads = No (4.2), gates proven by `test:native-ads` |
| "Deletion URL missing/invalid" | `/account-deletion` (4.8) |
| "Data safety inconsistent" | `docs/play-data-safety-form.md` |
| "Gambling policy" | 4.7 — the virtual-currency position |
| "Broken on tablet/foldable" | Pre-launch report; safe-area handling is in the shell |
