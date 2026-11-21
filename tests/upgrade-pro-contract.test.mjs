/**
 * GRYND PRO upgrade surface — contract guard for the Shop removal.
 *
 * The old token Shop (page, token purchase UI, its API routes) is gone and the
 * only paid product is the single GRYND PRO subscription. These are static
 * checks rather than mounting tests: the components need Clerk + a live Stripe
 * account, so they pin the CONTRACT that makes the flow safe:
 *
 *   1. the Shop is gone and can never sell anything again,
 *   2. the upgrade surface reuses the existing Stripe subscribe/portal routes,
 *   3. the price is resolved server-side from the plan catalog — no component
 *      hardcodes it,
 *   4. entitlement is server-authoritative: no client-side storage can claim
 *      PRO status,
 *   5. no token machinery is reachable from the upgrade flow,
 *   6. the CTA is placed on non-gameplay pages only.
 *
 * Run: node --import tsx --test tests/upgrade-pro-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const exists = (path) => fs.existsSync(path);

// ── Files that make up the upgrade experience ──────────────────────────────
const BUTTON = read("src/components/UpgradeProButton.tsx");
const MODAL = read("src/components/UpgradeProModal.tsx");
const CONTENT = read("src/components/UpgradeProContent.tsx");
const HOOK = read("src/lib/upgradePro.ts");
const DISPLAY = read("src/lib/membershipDisplay.ts");
const PAGE = read("src/app/upgrade-pro/page.tsx");
const PAGE_CLIENT = read("src/app/upgrade-pro/PageClient.tsx");
const SUBSCRIPTIONS = read("src/lib/stripe/subscriptions.ts");
const STATUS_ROUTE = read("src/app/api/membership/status/route.ts");
const SUBSCRIBE_ROUTE = read("src/app/api/stripe/subscribe/route.ts");
const PORTAL_ROUTE = read("src/app/api/stripe/portal/route.ts");
const NAVBAR = read("src/components/navigation-bar.jsx");
const PROXY = read("src/proxy.ts");
const TRANSLATIONS = read("src/lib/appTextTranslations.js");
const PRO_BILLING = read("src/lib/proBilling.ts");
const PRO_BENEFITS = read("src/lib/proBenefits.ts");
const PRO_TRIAL = read("src/lib/proTrial.ts");
const TIMELINE = read("src/components/ProTrialTimeline.tsx");
const FEATURED_REVIEW = read("src/lib/featuredReview.ts");
const REMINDER_JOB = read("src/app/api/jobs/pro-trial-reminders/route.ts");
const TRIAL_REMINDER_ROUTE = read("src/app/api/stripe/trial-reminder/route.ts");
const REMINDER_SETTINGS = read("src/components/ProTrialReminderSettings.tsx");
const MIGRATION_0215 = read("src/db/migrations/0215_pro_benefit_copy.sql");

const UPGRADE_SURFACE = { BUTTON, MODAL, CONTENT, HOOK, PAGE, PAGE_CLIENT };

test("the reusable upgrade components exist", () => {
  for (const path of [
    "src/components/UpgradeProButton.tsx",
    "src/components/UpgradeProModal.tsx",
    "src/components/UpgradeProContent.tsx",
    "src/lib/upgradePro.ts",
    "src/lib/membershipDisplay.ts",
    "src/app/upgrade-pro/page.tsx",
    "src/app/upgrade-pro/PageClient.tsx",
  ]) {
    assert.ok(exists(path), `${path} should exist`);
  }
});

test("the old Shop is gone (files deleted)", () => {
  for (const path of [
    "src/components/ShopBuyClient.tsx",
    "src/components/ShopItemsClient.tsx",
    "src/components/CosmeticsClient.tsx",
    "src/app/api/shop/items/route.js",
    "src/app/api/shop/items/route.ts",
    "src/app/api/shop/items/buy/route.js",
    "src/app/api/shop/items/buy/route.ts",
  ]) {
    assert.ok(!exists(path), `${path} should have been removed`);
  }
});

test("/shop redirects to /upgrade-pro and sells nothing", () => {
  // The route itself is gone — the legacy URL is a config-level 308, so it can
  // never render a shop again (and crawlers don't re-fetch a soft redirect).
  assert.ok(!exists("src/app/shop/page.tsx"), "the /shop route should be removed");
  const config = read("next.config.js");
  assert.match(
    config,
    /source: "\/shop",\s*\n\s*destination: "\/upgrade-pro",\s*\n\s*permanent: true,/,
  );
});

test("no page or component links to the removed Shop", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
      // The retired boost-activation endpoint is an API path, not a link (the
      // legacy /shop URL is now a config-level redirect, not a route file).
      if (path.startsWith("src/app/api/shop/")) continue;
      if (read(path).includes('\"/shop\"')) offenders.push(path);
    }
  };
  walk("src/app");
  walk("src/components");
  assert.deepEqual(offenders, [], `these files still link to /shop: ${offenders}`);
});

test("checkout, portal and success URLs all return to /upgrade-pro", () => {
  assert.match(SUBSCRIBE_ROUTE, /success_url: `\$\{baseUrl\}\/upgrade-pro/);
  assert.match(SUBSCRIBE_ROUTE, /cancel_url: `\$\{baseUrl\}\/upgrade-pro/);
  assert.match(PORTAL_ROUTE, /return_url: `\$\{baseUrl\}\/upgrade-pro`/);
  assert.ok(
    !SUBSCRIBE_ROUTE.includes("/shop") && !PORTAL_ROUTE.includes("/shop"),
    "Stripe return URLs must not point at the removed Shop",
  );
});

test("the Checkout page is GRYND-branded and its back button returns to /upgrade-pro", () => {
  const BRANDING = read("src/lib/stripe/checkoutBranding.ts");

  // The page carries our palette (dark navy backdrop, brand-yellow CTA) and
  // our name, so a member never lands on Stripe's stock white form.
  assert.match(BRANDING, /displayName: "GRYND PRO"/);
  assert.match(BRANDING, /backgroundColor: "#071536"/);
  assert.match(BRANDING, /buttonColor: "#f5ff3b"/);
  assert.match(BRANDING, /iconPath: "\/icon-192\.png"/);

  // Every Checkout Session we create goes through the branded helper, which
  // degrades instead of ever blocking a payment.
  assert.match(SUBSCRIBE_ROUTE, /createBrandedCheckoutSession\(/);

  // The Checkout back button is `cancel_url`, so it points at the GRYND PRO
  // page AND is built from the origin the customer checked out from — a stored
  // env value is only the fallback, never a hardcoded host.
  assert.match(SUBSCRIBE_ROUTE, /getReturnBaseUrl\(req\)/);
  assert.match(PORTAL_ROUTE, /getReturnBaseUrl\(req\)/);
  assert.ok(
    !SUBSCRIBE_ROUTE.includes("getBaseUrl()") &&
      !PORTAL_ROUTE.includes("getBaseUrl()"),
    "Stripe return URLs must resolve from the request origin, not a bare env read",
  );
});

test("the navbar offers GRYND PRO instead of a Shop", () => {
  assert.ok(!NAVBAR.includes('"/shop"'), "navbar must not link to /shop");
  assert.ok(NAVBAR.includes('"/upgrade-pro"'), "navbar should link to /upgrade-pro");
  assert.ok(
    !NAVBAR.includes("IconShoppingBag"),
    "the Shop bag icon should be gone from the navbar",
  );
});

test("the price is resolved server-side and rendered from the plan, never hardcoded", () => {
  // One authoritative resolver, reading the catalog / bound Stripe price, and
  // taking the currency the caller's country resolves to (base CAD when the
  // bound price has no amount configured for that currency).
  assert.match(SUBSCRIPTIONS, /export async function getProPlanDisplay\(/);
  assert.match(SUBSCRIPTIONS, /resolveSubscriptionPlanPriceCents\(/);
  assert.match(SUBSCRIPTIONS, /resolveProBillingAmountsForCurrency\(/);
  assert.match(STATUS_ROUTE, /getProPlanDisplay\(currency\)/);

  // The client surfaces render whatever the server resolved: the price comes
  // off the resolved plan's per-interval billing options — the component holds
  // no price of its own, for any of the three options.
  assert.match(CONTENT, /plan\.billingOptions/);
  assert.match(CONTENT, /option\.priceDisplay/);
  assert.doesNotMatch(CONTENT, /plan\.priceUsd\s*[=+\-]/, "the component must not derive a price");
  // …and the symbol is never written by a component either: it arrives with
  // the resolved option (`currencySymbol`), so a hardcoded "$" cannot survive
  // a currency switch.
  assert.ok(
    !/\$\{option\./.test(CONTENT),
    "the price must be rendered as resolved, not re-symbolised in the component",
  );
  // Every option's price is resolved server-side from a bound Stripe price.
  assert.match(PRO_BILLING, /PRO_BILLING_INTERVALS/);
  assert.match(SUBSCRIPTIONS, /stripePriceIdYearly|stripe_price_id_yearly/);
  assert.ok(
    !/\$\s?9\.99|\b999\b/.test(BUTTON + MODAL + CONTENT + PAGE_CLIENT),
    "no component may hardcode the subscription price",
  );

  // Exactly one numeric fallback in the whole resolver (a named constant).
  const declarations =
    SUBSCRIPTIONS.match(/FALLBACK_PRO_PRICE_CENTS = \d+/g) ?? [];
  assert.equal(declarations.length, 1, "only one price fallback is allowed");
  assert.ok(
    !/priceCents:\s*\d/.test(SUBSCRIPTIONS),
    "the resolver must not inline a numeric price outside the fallback constant",
  );
});

test("entitlement is server-authoritative — the client can never claim PRO", () => {
  assert.match(STATUS_ROUTE, /findActiveSubscription\(userId\)/);
  assert.match(STATUS_ROUTE, /active: true/);
  assert.match(STATUS_ROUTE, /active: false/);

  // The hook only ever adopts `active` from the response body — and only for a
  // Pro tier. (The shared store that dedupes the call keeps the same rule.)
  assert.match(HOOK, /active: Boolean\(data\?\.active\) && data\?\.tier === "pro"/);
  for (const [name, source] of Object.entries(UPGRADE_SURFACE)) {
    assert.ok(
      !/(localStorage|sessionStorage)\s*\./.test(source),
      `${name} must not read membership from client storage`,
    );
  }
  // The client sends a plan key and WHICH approved interval to buy — never a
  // price. The server resolves the amount from the bound Stripe price, and the
  // interval is validated server-side against the allowed set.
  assert.match(HOOK, /JSON\.stringify\(\{ planKey, interval, reminderDays \}\)/);
  assert.ok(
    !/JSON\.stringify\(\{[^}]*price/.test(HOOK),
    "the client must never send a price",
  );
  assert.match(SUBSCRIBE_ROUTE, /PRO_BILLING_INTERVALS|isProBillingInterval/);
});

test("the upgrade flow reuses the existing Stripe endpoints and no token system", () => {
  assert.match(HOOK, /fetch\("\/api\/stripe\/subscribe"/);
  assert.match(HOOK, /fetch\("\/api\/stripe\/portal"/);
  for (const [name, source] of Object.entries(UPGRADE_SURFACE)) {
    assert.ok(!source.includes("/api/shop"), `${name} must not touch the Shop API`);
    assert.ok(!source.includes("/api/tokens"), `${name} must not touch token APIs`);
    assert.ok(
      !source.includes("creditUserBalance") && !source.includes("tokenTransactions"),
      `${name} must not touch token crediting`,
    );
  }
});

test("the modal shows the GRYND PRO offer with the pack-mega artwork", () => {
  assert.match(CONTENT, /"\/images\/pack-mega\.png"/);

  // The offer copy is TRANSLATED, not hardcoded: the component renders the
  // shared `pro.*` keys, and each key it renders exists in the English bundle
  // that every locale falls back through.
  assert.match(CONTENT, /t\("pro\.lead"\)/);
  // The offer states the promise (master your game) and the reasons to pay:
  // post-match depth, a climb across every title, and visible standing.
  assert.match(
    TRANSLATIONS,
    /lead: "Master Your Game\. Go deeper after every match, track your climb across every title, and stand out on the ladder\."/,
  );
  assert.match(CONTENT, /t\("pro\.cta\.subscribe"/);
  assert.match(CONTENT, /t\("pro\.cta\.manage"\)/);
  // The CTA carries the fully formatted price (symbol included), so the copy has
  // no currency of its own — the same key is correct in CAD, USD, EUR…
  assert.match(
    TRANSLATIONS,
    /subscribe: "Start \{days}-day free trial — then \{price}\/\{unit}\"/,
  );
  assert.ok(
    /save: "Save \{percent\}% vs\. \{versus\} \(\{amount\}\/mo\)"/.test(
      TRANSLATIONS,
    ),
    "the saving is one crisp line: rounded percent, monthly price, no annual amount",
  );
  assert.ok(
    !TRANSLATIONS.includes("${amount}") && !/save: "Save \$/.test(TRANSLATIONS),
    "no pro.* copy may hardcode a currency symbol",
  );
  assert.match(TRANSLATIONS, /manage: "Manage subscription"/);

  // All three billing options are offered, and the offer states plainly that
  // they are the same membership.
  assert.match(CONTENT, /PRO_BILLING_INTERVALS\.map/);
  assert.match(TRANSLATIONS, /same_membership:/);

  // The advertised benefits come from ONE approved catalog (lib/proBenefits.ts)
  // — never from whatever a plan row happens to contain — and only benefits
  // marked `available` may be rendered. An approved-but-unbuilt benefit is
  // recorded and translated, but must not appear on the offer.
  assert.match(
    CONTENT,
    /import \{ ADVERTISED_PRO_BENEFITS \} from "\.\.\/lib\/proBenefits";/,
  );
  assert.match(CONTENT, /ADVERTISED_PRO_BENEFITS\.map/);
  assert.match(CONTENT, /t\(`pro\.benefit\.\$\{id\}`\)/);
  assert.match(
    PRO_BENEFITS,
    /export const ADVERTISED_PRO_BENEFITS: readonly ProBenefit\[\] = PRO_BENEFITS\.filter\(\s*\(benefit\) => benefit\.availability === "available",\s*\);/,
    "the advertised set must be derived from the catalog's availability",
  );
  assert.match(
    PRO_BENEFITS,
    /\{ id: "ad_free", availability: "available" \}/,
    "ad-free is enforced today (lib/adEntitlement.ts) and stays advertised",
  );
  // The refreshed box: analytics is shipped (the /stats dashboard, gated by
  // /api/stats/performance); the daily archive is gated by its own route; and
  // private rooms are still enforced by POST /api/rooms but are no longer part
  // of the box. Extended leaderboards with ranking graphs are still unbuilt.
  assert.match(
    PRO_BENEFITS,
    /\{ id: "analytics", availability: "available" \}/,
    "the performance dashboard exists and is gated — the catalog must say so",
  );
  assert.match(
    PRO_BENEFITS,
    /\{ id: "daily_archive", availability: "available" \}/,
    "the PRO daily archive route exists — advertise it",
  );
  assert.ok(
    !/id: "private_rooms"/.test(PRO_BENEFITS),
    "private rooms are out of the current value box",
  );
  assert.ok(
    !/id: "leaderboards", availability: "available"/.test(PRO_BENEFITS),
    "leaderboard graphs are not built yet — they must not be advertised",
  );

  // The perk row the API serves (/api/membership/status sends `plan.perks`) is
  // the same catalog, and the retired claims are gone from it. The comments in
  // the migration deliberately NAME the claims it removes (that is the audit
  // trail), so the check reads the statement — comments stripped — not the file.
  const sql = read("src/db/migrations/0261_pro_offer_refresh.sql")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.match(sql, /'100% Ad-Free Experience/);
  assert.ok(
    !/matchmaking/i.test(sql),
    "priority matchmaking is not sold while the queues are small",
  );
  assert.ok(
    !/Private custom rooms/i.test(sql),
    "private rooms are out of the current value box",
  );
  assert.ok(
    !/Detailed match history|Custom chat color|Priority support|customization/i.test(
      sql,
    ),
    "the plan row must not carry a retracted claim",
  );
});

test("every dynamic PRO string resolves in all three languages", async () => {
  const { t } = await import("../src/lib/appTextTranslations.js");

  // The keys the component BUILDS at runtime (template literals) can't be
  // grepped as literals, so they are enumerated here and resolved through the
  // real bundle. A locale that is missing one would otherwise render the raw
  // key — or silently fall back to English mid-sentence.
  const intervals = ["monthly", "yearly"];
  // Derived from the catalog, not a second hand-kept list: every approved
  // benefit must be translated in every locale — INCLUDING the ones not
  // advertised yet, so the surface that ships each feature only has to flip its
  // availability.
  const { PRO_BENEFIT_IDS } = await import("../src/lib/proBenefits.ts");
  const benefits = [...PRO_BENEFIT_IDS];
  const keys = [
    ...intervals.map((i) => `pro.interval.${i}`),
    ...intervals.map((i) => `pro.unit.${i}`),
    ...benefits.map((b) => `pro.benefit.${b}`),
    ...["subscribe", "switch", "manage", "opening"].map((k) => `pro.cta.${k}`),
    "pro.lead",
    "pro.headline",
    "pro.subtitle",
    "pro.membership",
    "pro.interval_group",
    "pro.badge.best_value",
    "pro.save",
    "pro.flexible_monthly",
    "pro.founder_anchor",
    "pro.founder_scarcity",
    "pro.selected",
    "pro.same_membership",
    "pro.cancel_anytime",
    "pro.active_plain",
    "pro.active_renews",
    "pro.close",
    "pro.benefits_title",
    "pro.preview.title",
    "pro.preview.sample",
    "pro.preview.alt",
    "pro.preview.range",
    "pro.preview.gain",
    "pro.preview.caption",
    "pro.trustpilot_label",
    "pro.no_advantage",
    "pro.error_generic",
    "pro.checkout_cancelled",
    "pro.checkout_activating",
    "pro.checkout_active",
    "pro.free_title",
    "pro.free_body",
    "pro.billing_title",
    "pro.billing_current",
    "pro.billing_options_lead",
    "pro.billing_change",
    "pro.billing_profile_lead",
    "pro.billing_profile_link",
    "pro.discount_line",
    "pro.value_line",
    "pro.testimonial_title",
    "pro.testimonial_rating",
    "pro.testimonial_verified",
    "pro.testimonial_anonymous",
    "pro.team_title",
    "pro.team_body",
    "pro.team_signature",
    ...[
      "title",
      "subtitle",
      "step_free",
      "step_reminder",
      "step_charge",
      "free_title",
      "free_body",
      "reminder_title",
      "reminder_body",
      "charge_title",
      "charge_body",
      "charge_pending",
      "charge_reminder",
      "charge_no_reminder",
      "back",
      "next",
      "step_of",
    ].map((key) => `pro.trial.${key}`),
    ...["3", "1", "0"].map((days) => `pro.trial.reminder_${days}`),
    ...[
      "used_note",
      "manage_title",
      "manage_body",
      "manage_body_no_date",
      "manage_cancel_hint",
      "manage_saved",
      "manage_error",
    ].map((key) => `pro.trial.${key}`),
    "pro.active_trial",
    "pro.cta.plain_subscribe",
  ];

  for (const lang of ["en", "fr", "es"]) {
    for (const key of keys) {
      const value = t(lang, key);
      assert.ok(
        typeof value === "string" && value.length > 0 && value !== key,
        `${lang} is missing ${key}`,
      );
    }
  }
});

test("the upgrade CTA sits on non-gameplay pages only", () => {
  // Pages that still sell PRO inline keep their button.
  for (const path of [
    "src/app/classement/PageClient.jsx",
    "src/app/settings/PageClient.jsx",
  ]) {
    assert.ok(
      read(path).includes("UpgradeProButton"),
      `${path} should render the upgrade CTA`,
    );
  }

  // The home page and the casino hub no longer carry an inline CTA — the
  // Solitaire-first redesign removed it. What replaced it is the GRYND PRO
  // card, mounted ONCE in SiteChrome and therefore present on every browsing
  // page including "/". That card is now the home page's upgrade entry point,
  // so it must exist, stay route-gated, and point at the real purchase page.
  const chrome = read("src/components/SiteChrome.tsx");
  assert.match(
    chrome,
    /shouldShowProWidget\(pathname\) && <GryndProWidget \/>/,
    "the site chrome must mount the gated GRYND PRO card",
  );
  const widget = read("src/components/GryndProWidget.tsx");
  assert.match(widget, /linkToPage/, "the card's CTA must open the upgrade page");
  assert.match(widget, /UPGRADE_PRO_PATH/);
  const gate = read("src/lib/proWidget.ts");
  assert.match(gate, /"\/upgrade-pro"/, "the upgrade page itself must be excluded");
  assert.match(gate, /"\/solitaire"/, "gameplay must be excluded");

  // Nothing under a match/board route may render the CTA: those paths are the
  // active-gameplay surfaces (the games hub itself is fine).
  const gameplayDirs = ["src/app/casino", "src/app/uno"];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
      // The hub page /casino/PageClient.jsx is a non-gameplay surface.
      if (path === "src/app/casino/PageClient.jsx") continue;
      if (read(path).includes("UpgradeProButton")) offenders.push(path);
    }
  };
  for (const dir of gameplayDirs) if (exists(dir)) walk(dir);
  assert.deepEqual(offenders, [], `upgrade CTA found inside gameplay: ${offenders}`);
});

test("the analytics benefit ships a sample visual preview", () => {
  // The bullet promises "graphs"; the card shows what that means. It is a
  // static sample (no dashboard fetch, no account data) and is labelled as one.
  assert.match(CONTENT, /data-testid="pro-analytics-preview"/);
  assert.match(CONTENT, /pro\.preview\.title/);
  assert.match(CONTENT, /pro\.preview\.sample/);
  assert.match(CONTENT, /pro\.preview\.alt/);
  assert.match(CONTENT, /<svg/);
  assert.match(CONTENT, /role="img"/);
  assert.doesNotMatch(CONTENT, /useApiResource|fetch\(/);
});

test("the offer carries no third-party review widget", () => {
  // Trustpilot's TrustBox was removed from the PRO offer: it loaded a
  // third-party script beside the CTA, and the offer's social proof is the one
  // approved review rendered below (pro-testimonial). No rating or review count
  // may be typed into the component either.
  assert.doesNotMatch(CONTENT, /trustpilot/i, "no Trustpilot surface on the offer");
  assert.ok(
    !/[45].d|d{2,}s*(reviews|avis|opiniones)/i.test(CONTENT),
    "no rating or review count may be typed into the component",
  );
});

test("the upgrade landing page is public and never prerendered for one user", () => {
  assert.ok(PROXY.includes('"/upgrade-pro"'), "proxy should treat it as public");
  assert.match(PAGE, /dynamic = "force-dynamic"/);
  assert.match(PAGE, /findActiveSubscription/);
  assert.match(PAGE, /getProPlanDisplay/);
});

test("the paywall sells a free trial it can actually honour", () => {
  // A real Stripe trial: the checkout creates it, and entitlement already
  // treats `trialing` as active, so the timeline describes what happens.
  assert.match(SUBSCRIBE_ROUTE, /trial_period_days: trialDays/);
  assert.match(SUBSCRIBE_ROUTE, /trialReminderDays: String\(reminderDays\)/);
  assert.match(PRO_TRIAL, /export const PRO_TRIAL_DAYS = 7/);
  assert.match(PRO_TRIAL, /PRO_TRIAL_REMINDER_DAYS = \[3, 1, 0\]/);

  // Three slides on the offer: try it free, pick a reminder, see the charge.
  assert.match(CONTENT, /<ProTrialTimeline/);
  assert.match(CONTENT, /onReminderChange=\{setReminderDays\}/);
  assert.match(TIMELINE, /const STEPS = \["free", "reminder", "charge"\]/);
  assert.match(TIMELINE, /data-testid=\{`pro-trial-step-\$\{id\}`\}/);
  assert.match(TIMELINE, /data-testid="pro-trial-panel-charge"/);
  assert.match(TIMELINE, /PRO_TRIAL_REMINDER_DAYS\.map/);

  // The reminder the member picks is actually sent, and "no reminder" is
  // honoured rather than sent anyway.
  assert.match(REMINDER_JOB, /sendProTrialReminder/);
  assert.match(REMINDER_JOB, /metadata\?\.trialReminderDays/);
  assert.match(REMINDER_JOB, /reminderDays === 0/);
  const cron = JSON.parse(read("vercel.json"));
  assert.ok(
    cron.crons.some((entry) => entry.path === "/api/jobs/pro-trial-reminders"),
    "the reminder sweep must be scheduled",
  );
});

test("the discount, the testimonial and the team note are all real", () => {
  // Front and centre: the saving is DERIVED from the resolved options, never
  // typed into the component as marketing copy.
  assert.match(CONTENT, /data-testid="pro-discount-percent"/);
  assert.match(CONTENT, /yearlyOption\?\.savings\[0\]/);
  assert.match(CONTENT, /pro\.discount_line/);

  // The feature list answers "is it worth it?" with a derived weekly price.
  assert.match(CONTENT, /data-testid="pro-value-line"/);
  assert.match(CONTENT, /pro\.value_line/);
  assert.match(CONTENT, /const weeklyCents =/);

  // The testimonial is one approved review from the moderated wall, resolved
  // on the server — never a quote or rating written into the component.
  assert.match(CONTENT, /data-testid="pro-testimonial"/);
  assert.match(PAGE, /getApprovedReviews/);
  assert.match(PAGE, /pickFeaturedReview/);
  assert.match(FEATURED_REVIEW, /export function pickFeaturedReview/);
  assert.match(FEATURED_REVIEW, /MIN_QUOTE_LENGTH/);
  assert.ok(
    !/★★★★★|"5\.0"|4\.9 out of 5/.test(CONTENT),
    "the paywall must not type a rating or a quote",
  );

  // The note from the team is copy, and it says why the subscription exists.
  assert.match(CONTENT, /data-testid="pro-team-note"/);
  assert.match(TRANSLATIONS, /team_body:/);
});

test("the free trial is granted once per customer, and the paywall says so", () => {
  // The guard is a server read of the caller's own rows: a canceled
  // subscription row still counts as "already had the trial".
  assert.match(SUBSCRIPTIONS, /export async function hasPriorSubscription/);
  assert.match(SUBSCRIBE_ROUTE, /hasPriorSubscription\(clerkId\)/);
  assert.match(SUBSCRIBE_ROUTE, /const trialDays = /);
  assert.match(
    SUBSCRIBE_ROUTE,
    /\.\.\.\(trialDays > 0 \? \{ trial_period_days: trialDays \} : \{\}\)/,
    "checkout must omit the trial entirely for a returning customer",
  );

  // Eligibility travels from the server to every surface; a client flag cannot
  // claim a trial the server would not grant.
  assert.match(STATUS_ROUTE, /hasPriorSubscription\(userId\)/);
  assert.match(STATUS_ROUTE, /trialEligible/);
  assert.match(HOOK, /trialEligible: state\.trialEligible,/);
  assert.match(CONTENT, /trialEligible === true/);
  assert.match(CONTENT, /pro\.cta\.plain_subscribe/);
  assert.match(CONTENT, /data-testid="pro-trial-used-note"/);
  assert.match(PAGE, /hasPriorSubscription/);
});

test("a trialing member can change or cancel the reminder after checkout", () => {
  // The panel writes only the caller's OWN trialing subscription's metadata —
  // the same field the reminder sweep reads.
  assert.match(TRIAL_REMINDER_ROUTE, /findTrialingSubscription\(/);
  assert.match(TRIAL_REMINDER_ROUTE, /loadOwnTrial\(userId\)/);
  assert.match(TRIAL_REMINDER_ROUTE, /subscriptions\.update\(/);
  assert.match(TRIAL_REMINDER_ROUTE, /trialReminderDays: String\(reminderDays\)/);
  assert.match(TRIAL_REMINDER_ROUTE, /isProTrialReminderDays/);

  assert.match(REMINDER_SETTINGS, /data-testid="pro-trial-reminder-settings"/);
  assert.match(REMINDER_SETTINGS, /PRO_TRIAL_REMINDER_DAYS\.map/);
  assert.match(REMINDER_SETTINGS, /updateProTrialReminder/);
  assert.match(HOOK, /export async function updateProTrialReminder/);

  // It is mounted only for a live trial on the upgrade page.
  assert.match(PAGE_CLIENT, /<ProTrialReminderSettings/);
  assert.match(PAGE_CLIENT, /status\.status === "trialing"/);

  // And there is a real browser click-through for the trial slides.
  assert.ok(exists("qa/pro-paywall-check.mjs"), "the paywall click-through must exist");
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["verify:paywall"], "node qa/pro-paywall-check.mjs");
});

test("the retired High Roller title is renamed in the migration", () => {
  const migration = read("src/db/migrations/0169_battlepass_title_apex.sql");
  assert.match(migration, /UPDATE "user_special_titles"/);
  assert.match(migration, /DELETE FROM "special_titles" WHERE "key" = 'bp_high_roller_legend'/);
  assert.ok(
    read("src/db/migrations/meta/_journal.json").includes("0169_battlepass_title_apex"),
    "the migration must be journaled",
  );
});
