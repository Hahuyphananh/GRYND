# App Store Connect — App Privacy Answers

Reference for submitting GRYND to the App Store. These answers mirror the
iOS privacy manifest (`ios/App/App/PrivacyInfo.xcprivacy`) and the Play Data
Safety form (`docs/play-data-safety-form.md`) — all three must tell the same
story or Apple/Google review will flag a mismatch.

Location: App Store Connect → **App Privacy** (your app → *App Privacy*).

---

## Part 1 — Tracking

| Question | Answer |
|---|---|
| **Does your app collect data from your app that is linked to the user's identity, and used for tracking purposes (e.g. across apps or websites owned by other companies)?** | **No** |

PostHog analytics are consent-gated and used only for in-app product
analytics; the app does not share data with advertisers or track users
across other companies' apps/sites (matches the privacy policy).

---

## Part 2 — Data collected (one entry per data type)

For every row below:

- **Collected?** Yes
- **Linked to the user?** Yes
- **Used for tracking?** No
- **Purposes:** as listed per row

### Contact Info

| Data type | Collected | Linked | Tracking | Purposes |
|---|---|---|---|---|
| **Name** | Yes | Yes | No | App Functionality, Analytics |
| **Email Address** | Yes | Yes | No | App Functionality, Analytics |

Collected from the user via Clerk signup. Email is passed to PostHog
(`posthog.identify(user.id, { name, email })`) for analytics
(`src/components/PostHogIdentify.tsx`).

### User Content

| Data type | Collected | Linked | Tracking | Purposes |
|---|---|---|---|---|
| **User Content** (profile pictures, chat messages) | Yes | Yes | No | App Functionality, Personalization |

Profile pictures are uploaded by the user (user-initiated). Chat messages
are user-generated in the global/game chat.

### Identifiers

| Data type | Collected | Linked | Tracking | Purposes |
|---|---|---|---|---|
| **User ID** | Yes | Yes | No | Analytics |

The Clerk user ID is sent to PostHog to tie game events to a profile, and
is included in Sentry diagnostics for crash attribution.

### Purchases

| Data type | Collected | Linked | Tracking | Purposes |
|---|---|---|---|---|
| **Purchase History** | Yes | Yes | No | App Functionality |

Token purchases and bet/transaction history (balances, wins, losses) are
stored server-side (Neon).

### Usage Data

| Data type | Collected | Linked | Tracking | Purposes |
|---|---|---|---|---|
| **Product Interaction** | Yes | Yes | No | Analytics |

Game events (`game_started`, `game_ended`, etc.) captured in PostHog,
gated by the cookie-consent banner (`opt_in_capturing`).

### Diagnostics

| Data type | Collected | Linked | Tracking | Purposes |
|---|---|---|---|---|
| **Crash Data** | Yes | Yes | No | App Functionality, Analytics |
| **Performance Data** | Yes | Yes | No | App Functionality, Analytics |

Sentry (`@sentry/nextjs`) — crash and performance telemetry.

---

## What is NOT collected

Leave **No** for everything else, including:

- Location (precise/coarse), Phone Number, Physical Address, Other Contact Info
- Health & Fitness, Financial Info, Sensitive Info, Contacts, Calendar
- Search History, Browsing History, Audio Data, Videos, Other Usage Data
- Device ID, Advertising Data, Other Diagnostics

---

## Consistency checklist

- [ ] Matches `ios/App/App/PrivacyInfo.xcprivacy` (same data types, same
      linked/tracking flags)
- [ ] Matches `docs/play-data-safety-form.md` (same data story for Google)
- [ ] Matches the privacy policy at `/privacy-policy` (names, email, DOB,
      profile pictures, game history, analytics, no selling)
- [ ] Re-verify before each submission — if a data practice changes (new
      analytics vendor, ads, phone signup), update all three in one pass
