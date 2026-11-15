// src/lib/emails/reviewInvite.ts
//
// THE TRUSTPILOT REVIEW INVITATION — one honest request per player.
//
// HOW TRUSTPILOT INVITATIONS WORK: the operator sends the customer a normal
// email and adds the business's personal `…@invite.trustpilot.com` address as a
// BCC. Trustpilot receives that copy and sends its own invitation to the
// customer. The address is therefore a delivery channel, not a From/To header —
// putting it in `to` would send the customer's invitation to Trustpilot only.
//
// RULES THIS MODULE KEEPS:
//   * only an ACTUAL player is invited (the campaign script filters on played
//     games; bots and test accounts never qualify),
//   * the recipient must not have opted out of promotional email (the shared
//     pipeline re-checks the preference too),
//   * the copy asks for an HONEST review and offers nothing in return — paying
//     for or filtering reviews breaks Trustpilot's rules and would be a lie to
//     the next player reading them,
//   * one invitation per account, ever (`dedupeKey` + the campaign's own
//     email_events check),
//   * every send carries the platform's signed unsubscribe footer and RFC 8058
//     one-click headers, because `sendEmailSafely` is called with
//     `category: "marketing"`.

import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
} from "../../db/schema";
import { escapeHtml, renderTemplate, sendEmailSafely } from "./base";

/** The Trustpilot invitation address issued for grynd.dedyn.io. */
export const TRUSTPILOT_INVITE_BCC =
  "grynd.dedyn.io+ad758e4113@invite.trustpilot.com";

/** Where a player actually writes (or edits) their review. */
export const TRUSTPILOT_REVIEW_URL =
  "https://www.trustpilot.com/evaluate/grynd.dedyn.io";

/**
 * The `email_events.type` of an invitation. It is also the campaign's dedupe
 * namespace: a second run sees the first one's sent rows and skips them.
 */
export const REVIEW_INVITE_TYPE = "trustpilot_review_invite";

const BOT_EMAIL = /@grynd\.local$/i;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ReviewInviteCandidate = {
  clerkId?: string | null;
  email?: string | null;
  name?: string | null;
  age?: number | string | null;
  notificationPrefs?: Partial<NotificationPrefs> | null;
};

/**
 * Whether this account may receive a review invitation.
 *
 * Deliberately conservative: a missing account id or email cannot be safely
 * deduped or unsubscribed, a bot address is not a customer, a KNOWN minor is
 * never marketed to, and `promotions: false` is a refusal we honour before the
 * shared pipeline has to.
 */
export function isReviewInviteEligible(
  user: ReviewInviteCandidate | null | undefined,
): boolean {
  if (!user) return false;
  const clerkId = String(user.clerkId ?? "").trim();
  const email = String(user.email ?? "").trim();
  if (!clerkId || !EMAIL_SHAPE.test(email)) return false;
  if (BOT_EMAIL.test(email)) return false;

  const age = Number(user.age);
  if (Number.isFinite(age) && age > 0 && age < 18) return false;

  const prefs: NotificationPrefs = {
    ...DEFAULT_NOTIFICATION_PREFS,
    ...(user.notificationPrefs ?? {}),
  };
  return prefs.promotions !== false;
}

/**
 * The invitation body. `name` is player-controlled, so it is escaped.
 *
 * There is no incentive, no rating target and no "5 stars" ask: the only thing
 * requested is the player's honest experience, which is what Trustpilot (and
 * the next reader) requires.
 */
export function buildReviewInviteHtml({
  name,
}: {
  name?: string | null;
} = {}): string {
  const player = escapeHtml(String(name ?? "").trim() || "Player");
  return renderTemplate(
    "How was your GRYND game?",
    `<p>Hey ${player},</p>` +
      "<p>You've played GRYND — if you have a minute, a short review on " +
      "Trustpilot helps other players find a fair, fun place to play.</p>" +
      "<p>Please share your honest experience, good or bad. We read every " +
      "review and use it to fix what isn't working.</p>",
    "Leave a review",
    TRUSTPILOT_REVIEW_URL,
  );
}

/**
 * Send one invitation through the platform's shared email pipeline.
 *
 * `category: "marketing"` is what attaches the signed unsubscribe footer and
 * the one-click headers; the pipeline also applies the promotion preference and
 * the 24-hour marketing rate limit, so a skipped result is a normal outcome.
 */
export async function sendReviewInvite(user: {
  clerkId: string;
  email: string;
  name?: string | null;
}) {
  return sendEmailSafely({
    user,
    type: REVIEW_INVITE_TYPE,
    category: "marketing",
    dedupeKey: `trustpilot-review-invite:${user.clerkId}`,
    subject: "How was your GRYND game?",
    html: buildReviewInviteHtml({ name: user.name }),
    bcc: TRUSTPILOT_INVITE_BCC,
  });
}
