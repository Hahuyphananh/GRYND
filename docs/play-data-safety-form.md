# Play Console — Data Safety Form Answers

Reference for submitting GRYND to Google Play. These answers are grounded in
the actual data flows (Clerk auth, PostHog analytics, Sentry crash reporting,
game/bet records in Neon) and must stay consistent with the privacy policy at
`/privacy-policy` and the iOS privacy manifest
(`ios/App/App/PrivacyInfo.xcprivacy`).

Location: Play Console → **App content** → **Privacy and security** → **Data
safety**. The form is three steps.

---

## Step 1 — Data types collected & shared

Tick **yes** for the rows below; leave everything else (location, contacts,
health, web browsing, etc.) at **no / not collected**.

| Data type              | Collected? | Shared? | Notes                                                                               |
| ---------------------- | ---------- | ------- | ----------------------------------------------------------------------------------- |
| **Email address**      | Yes        | Yes     | Collected from the user. Shared with analytics (PostHog) and fraud/security vendors |
| **Name**               | Yes        | Yes     | Collected from the user. Shared with analytics and fraud/security                   |
| **User IDs**           | Yes        | Yes     | Generated in-app. Shared with analytics (PostHog `identify`) and fraud/security     |
| **Photos**             | Yes        | Yes     | Only if the user uploads a profile picture. Mark "collected with user consent"      |
| **Purchase history**   | Yes        | Yes     | Token purchases and bet transactions. Shared with fraud/security                    |
| **Gameplay content**   | Yes        | Yes     | Game activity, bets, wins/losses, balances, chat messages. Shared with analytics    |
| **Crash logs**         | Yes        | Yes     | Sentry. Shared with analytics (error monitoring)                                    |
| **Diagnostics**        | Yes        | Yes     | Sentry replay / PostHog events. Shared with analytics                               |
| **Other app activity** | Yes        | Yes     | Game events captured in PostHog. Shared with analytics                              |

### Per-row questions (asked for every collected row)

- **Is this data collected, shared, or both?** → Both
- **Is this data processed ephemerally?** → No (stored server-side)
- **Is this data used for a purpose other than the core function of the
  app?** → Yes: **Analytics** and **Fraud prevention, security, and
  compliance**
- **Can users request to have this data deleted?** → Yes (self-service
  account deletion + 30-day erasure promise)
- **Is this data collected or shared on an opt-in basis?** → Yes (PostHog /
  Sentry are gated by the cookie-consent banner; profile photo is
  user-initiated)

---

## Step 2 — Security & privacy practices

| Question                                     | Answer                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data encrypted in transit**                | Yes — TLS 1.3                                                                                                                                                                   |
| **Data encrypted at rest**                   | Yes — AES-256                                                                                                                                                                   |
| **Users can request data deletion**          | Yes — in-app deletion is immediate (Profile → Danger zone); a request made while signed out is handled through the contact form within 30 days. Public URL: `/account-deletion` |
| **Committed to Google Play Families Policy** | No — 18+ platform (age-verified), not child-directed                                                                                                                            |

---

## Step 3 — Declaration questions

| Question                                                           | Answer                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Implemented data safety practices described in privacy policy?** | Yes                                                               |
| **Does the app have a privacy policy?**                            | Yes — paste the live `/privacy-policy` URL                        |
| **Collects any data not listed in the form?**                      | No                                                                |
| **Do you sell user data?**                                         | No                                                                |
| **SDKs that collect data?**                                        | Yes — PostHog (analytics), Sentry (crash reporting), Clerk (auth) |

---

## Step 4 — Ads, purchases and gambling declarations

These sit under **App content** next to the Data safety form, and they must
match what the app actually does — not what the website does.

| Question                          | Answer                                                    | Why                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Does your app contain ads?**    | **No**                                                    | All three ad surfaces are gated off inside the shell: AdSense (`AdSenseScript`, `AdSlot`), the Hilltop banner (`HilltopBanner`), and the post-match video (`GET /api/ads/post-match`). If any of those switches is ever turned on again, this answer flips to Yes and the listing copy must change with it. |
| **In-app purchases?**             | **No**                                                    | Coin packs and GRYND PRO checkout return 403 inside the app (Play Billing is required for digital goods sold in-app, so the app sells nothing). Coins are bought on the website only.                                                                                                                       |
| **Financial features / gambling** | Declare **simulated gambling with virtual currency**, 18+ | Coins are virtual credits with no cash value and cannot be redeemed, which is the simulated-gambling case. If coins can ever be purchased with real money _inside the app_, this becomes the Play Billing + gambling question instead.                                                                      |
| **Target audience**               | 18+ only, not child-directed                              | Age is verified at sign-up; do not opt into the Families programme.                                                                                                                                                                                                                                         |
| **App access**                    | Restricted — provide working credentials                  | See `docs/play-store-listing.md` for the text to paste and a dedicated reviewer account to create.                                                                                                                                                                                                          |

Keep the ads answer honest per release: `npm run test:native-ads` fails if a
gate is removed, which is the signal to revisit this table.

## Consistency checklist

- [ ] Privacy policy URL in Play Console points to the live `/privacy-policy`
      page
- [ ] These answers match the iOS privacy manifest
      (`ios/App/App/PrivacyInfo.xcprivacy`) and the App Store Connect
      questionnaire — both tell the same story
- [ ] "Shared" answers reflect SDK processors (PostHog / Sentry / Clerk);
      this is normal for apps with analytics. The "sold" answer is No.
