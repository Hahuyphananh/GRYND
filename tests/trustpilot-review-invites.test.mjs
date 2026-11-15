/**
 * tests/trustpilot-review-invites.test.mjs
 *
 * The Trustpilot review-invite campaign.
 *
 * WHAT IS TESTED FOR REAL:
 *   * the audience predicate — real address, no bot account, no known minor,
 *     promotions preference respected;
 *   * the copy — the player name is escaped, the review link is the evaluate
 *     page, and nothing offers a reward or asks for a positive rating;
 *   * the BCC address is exactly the one issued for grynd.dedyn.io and is the
 *     only place it lives.
 *
 * STRUCTURALLY (no network, no database):
 *   * the shared pipeline forwards `bcc` on BOTH delivery paths (Resend and the
 *     SMTP fallback), and review invites go out as marketing mail so the
 *     unsubscribe footer/headers are attached;
 *   * the script is a DRY RUN unless `--send` is passed, excludes bot accounts
 *     and already-invited addresses, and is capped.
 *
 * Run: node --import tsx --test tests/trustpilot-review-invites.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  REVIEW_INVITE_TYPE,
  TRUSTPILOT_INVITE_BCC,
  TRUSTPILOT_REVIEW_URL,
  buildReviewInviteHtml,
  isReviewInviteEligible,
} from "../src/lib/emails/reviewInvite.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const PLAYER = {
  clerkId: "user_123",
  email: "player@example.com",
  name: "Ada",
  age: 24,
  notificationPrefs: { promotions: true, daily: true, summary: true, progress: true },
};

test("only a real, opted-in, adult player account is eligible", () => {
  assert.equal(isReviewInviteEligible(PLAYER), true);

  // No account id means the send could not be deduped or unsubscribed.
  assert.equal(isReviewInviteEligible({ ...PLAYER, clerkId: "" }), false);
  // Not an address.
  assert.equal(isReviewInviteEligible({ ...PLAYER, email: "not-an-email" }), false);
  // The practice bots are not customers.
  assert.equal(isReviewInviteEligible({ ...PLAYER, email: "bot@grynd.local" }), false);
  // A known minor is never marketed to.
  assert.equal(isReviewInviteEligible({ ...PLAYER, age: 16 }), false);
  // Promotion opt-out is honoured before the pipeline even runs.
  assert.equal(
    isReviewInviteEligible({
      ...PLAYER,
      notificationPrefs: { promotions: false },
    }),
    false,
  );
  // Unknown age/preferences fall back to the platform defaults (opt-out model).
  assert.equal(
    isReviewInviteEligible({ ...PLAYER, age: null, notificationPrefs: null }),
    true,
  );
  assert.equal(isReviewInviteEligible(null), false);
});

test("the invitation asks for an honest review and offers nothing in return", () => {
  const html = buildReviewInviteHtml({ name: "Ada" });
  assert.match(html, /honest/i);
  assert.ok(html.includes(TRUSTPILOT_REVIEW_URL));
  assert.match(html, /Ada/);
  assert.ok(
    !/\b(reward|coins?|incentive|gift|discount|prize|five stars|5 stars)\b/i.test(html),
    "Trustpilot forbids incentivised or selectively positive reviews",
  );

  // A player-controlled name can never become markup.
  const escaped = buildReviewInviteHtml({ name: '<img src=x onerror="alert(1)">' });
  assert.ok(!escaped.includes("<img src=x"));
  assert.match(escaped, /&lt;img/);
});

test("the BCC address is Trustpilot's invite channel for grynd.dedyn.io", () => {
  assert.equal(
    TRUSTPILOT_INVITE_BCC,
    "grynd.dedyn.io+ad758e4113@invite.trustpilot.com",
  );
  assert.equal(TRUSTPILOT_REVIEW_URL, "https://www.trustpilot.com/evaluate/grynd.dedyn.io");

  // One constant, one place: the campaign and template must not hard-code it.
  const source = read("src/lib/emails/reviewInvite.ts");
  assert.equal(source.split(TRUSTPILOT_INVITE_BCC).length - 1, 1);
  assert.match(source, /bcc: TRUSTPILOT_INVITE_BCC/);
});

test("review invites are marketing mail and travel on the BCC channel", () => {
  const source = read("src/lib/emails/reviewInvite.ts");
  assert.match(source, /category: "marketing"/);
  assert.match(source, /dedupeKey: `trustpilot-review-invite:\$\{user\.clerkId\}`/);

  const base = read("src/lib/emails/base.ts");
  // The pipeline accepts and forwards BCC on the Resend path…
  assert.match(base, /bcc\?: string \| string\[\]/);
  assert.match(base, /\.\.\.\(bcc \? \{ bcc \} : \{\}\)/);
  // …maps the invite type to the promotional preference…
  assert.match(base, /trustpilot_review_invite: "promotions"/);
  // …and attaches unsubscribe headers because the category is marketing.
  assert.match(base, /List-Unsubscribe/);

  // The SMTP fallback must not silently drop the blind recipient.
  const smtp = read("src/lib/resend.ts");
  assert.match(smtp, /bcc: opts\.bcc/);
});

test("the campaign script is a dry run unless explicitly told to send", () => {
  const source = read("scripts/send-trustpilot-invites.mjs");

  assert.match(source, /const SEND = argv\.includes\("--send"\)/);
  assert.match(source, /DRY RUN — no email was sent/);
  assert.match(source, /email NOT ILIKE '%@grynd\.local'/);
  assert.match(source, /review_invite|REVIEW_INVITE_TYPE/);
  assert.match(source, /LIMIT \* 10/);
  assert.match(source, /alreadyInvited/);
  // Addresses stay masked in the operator's terminal/logs.
  assert.match(source, /maskEmail\(row\.email\)/);
  // Sending refuses to run without a configured provider.
  assert.match(source, /No mail provider configured/);
  assert.match(source, /REVIEW_INVITE_TYPE/);
  assert.equal(REVIEW_INVITE_TYPE, "trustpilot_review_invite");
});
