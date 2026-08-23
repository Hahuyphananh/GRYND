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

| Data type | Collected? | Shared? | Notes |
|---|---|---|---|
| **Email address** | Yes | Yes | Collected from the user. Shared with analytics (PostHog) and fraud/security vendors |
| **Name** | Yes | Yes | Collected from the user. Shared with analytics and fraud/security |
| **User IDs** | Yes | Yes | Generated in-app. Shared with analytics (PostHog `identify`) and fraud/security |
| **Photos** | Yes | Yes | Only if the user uploads a profile picture. Mark "collected with user consent" |
| **Purchase history** | Yes | Yes | Token purchases and bet transactions. Shared with fraud/security |
| **Gameplay content** | Yes | Yes | Game activity, bets, wins/losses, balances, chat messages. Shared with analytics |
| **Crash logs** | Yes | Yes | Sentry. Shared with analytics (error monitoring) |
| **Diagnostics** | Yes | Yes | Sentry replay / PostHog events. Shared with analytics |
| **Other app activity** | Yes | Yes | Game events captured in PostHog. Shared with analytics |

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

| Question | Answer |
|---|---|
| **Data encrypted in transit** | Yes — TLS 1.3 |
| **Data encrypted at rest** | Yes — AES-256 |
| **Users can request data deletion** | Yes — in-app account deletion and delete via contact page, within 30 days |
| **Committed to Google Play Families Policy** | No — 18+ platform (age-verified), not child-directed |

---

## Step 3 — Declaration questions

| Question | Answer |
|---|---|
| **Implemented data safety practices described in privacy policy?** | Yes |
| **Does the app have a privacy policy?** | Yes — paste the live `/privacy-policy` URL |
| **Collects any data not listed in the form?** | No |
| **Do you sell user data?** | No |
| **SDKs that collect data?** | Yes — PostHog (analytics), Sentry (crash reporting), Clerk (auth) |

---

## Consistency checklist

- [ ] Privacy policy URL in Play Console points to the live `/privacy-policy`
      page
- [ ] These answers match the iOS privacy manifest
      (`ios/App/App/PrivacyInfo.xcprivacy`) and the App Store Connect
      questionnaire — both tell the same story
- [ ] "Shared" answers reflect SDK processors (PostHog / Sentry / Clerk);
      this is normal for apps with analytics. The "sold" answer is No.
