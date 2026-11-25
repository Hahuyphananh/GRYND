#!/usr/bin/env node
/**
 * scripts/send-trustpilot-invites.mjs
 *
 * Ask players to review GRYND on Trustpilot.
 *
 * HOW IT SENDS: each player gets one short email from the platform's normal
 * pipeline, with Trustpilot's personal invitation address
 * (grynd.dedyn.io+ad758e4113@invite.trustpilot.com) in BCC. Trustpilot receives
 * that copy and sends the player its own review invitation. The address is
 * NEVER put in `to` — doing that would route the player's invite to Trustpilot
 * only.
 *
 * WHO IS CONTACTED:
 *   • real player accounts only (at least one played game), never the bot
 *     accounts (`@grynd.local`) or test signups,
 *   • accounts that have not opted out of promotional email
 *     (`notification_prefs.promotions !== false`),
 *   • known minors (age < 18) are excluded,
 *   • each account at most once, ever — the campaign's own email_events rows
 *     and the shared dedupe key both enforce it.
 *
 * The email is a request for an HONEST review with nothing offered in return.
 * Trustpilot forbids incentivised or selectively positive reviews, and the copy
 * in src/lib/emails/reviewInvite.ts says so.
 *
 * Let the shared pipeline do the rest: it applies the per-user preference, the
 * 24-hour marketing rate limit, the signed unsubscribe footer and the RFC 8058
 * one-click headers.
 *
 * USAGE
 *   npm run email:trustpilot                         # dry run (default)
 *   npm run email:trustpilot -- --limit=50           # dry run, larger scan
 *   npm run email:trustpilot -- --send --limit=50    # actually send to 50
 *   npm run email:trustpilot -- --send --email=you@example.com
 *
 * OPTIONS
 *   --send               actually send (without it this is read-only)
 *   --limit=N            max recipients this run (default 50, max 200)
 *   --after-id=N         start after this users.id (for a big list, run again)
 *   --email=ADDR         target one account (repeatable; useful as a test)
 *   --exclude=ADDR       never contact this address (repeatable)
 *
 * REQUIRES a mail provider: RESEND_API_KEY (+ RESEND_FROM_EMAIL), or SMTP_HOST
 * with SMTP_USER / SMTP_PASS. The dry run needs only DATABASE_URL.
 *
 * NOTE: a dry run prints MASKED addresses. The whole point is to verify the
 * audience and the copy before contacting people, not to export a mailing list.
 */

import { getPool } from "../src/db/pool.ts";
import {
  REVIEW_INVITE_TYPE,
  isReviewInviteEligible,
  sendReviewInvite,
} from "../src/lib/emails/reviewInvite.ts";

const argv = process.argv.slice(2);
const SEND = argv.includes("--send");

function flag(name) {
  const prefix = `--${name}=`;
  const values = argv
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length).trim())
    .filter(Boolean);
  return values;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

const LIMIT = clamp(argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 50, 1, 200);
const AFTER_ID = clamp(argv.find((a) => a.startsWith("--after-id="))?.split("=")[1] ?? 0, 0, Number.MAX_SAFE_INTEGER);
const TARGET_EMAILS = new Set(flag("email").map((value) => value.toLowerCase()));
const EXCLUDED_EMAILS = new Set(flag("exclude").map((value) => value.toLowerCase()));

/** Keep PII out of terminal scrollback and CI logs. */
function maskEmail(email) {
  const value = String(email ?? "");
  const at = value.indexOf("@");
  if (at <= 0) return "***";
  return `${value[0]}***${value.slice(at)}`;
}

const provider =
  Boolean(process.env.RESEND_API_KEY?.trim()) || Boolean(process.env.SMTP_HOST?.trim());

if (SEND && !provider) {
  console.error(
    "No mail provider configured. Set RESEND_API_KEY (+ RESEND_FROM_EMAIL), " +
      "or SMTP_HOST with SMTP_USER / SMTP_PASS, then run again.",
  );
  process.exit(1);
}

const pool = getPool();

try {
  // "Players on the user list": accounts with at least one played game. A
  // signup that never played is not a customer, and Trustpilot invitations are
  // for customers.
  const params = [AFTER_ID];
  let sql =
    "SELECT id, clerk_id, name, email, age, notification_prefs " +
    "FROM users " +
    "WHERE id > $1 " +
    "AND COALESCE(games_won, 0) + COALESCE(games_lost, 0) + COALESCE(pvp_wins, 0) > 0 " +
    "AND COALESCE(email, '') <> '' " +
    "AND email NOT ILIKE '%@grynd.local' ";
  if (TARGET_EMAILS.size > 0) {
    const targets = [...TARGET_EMAILS];
    params.push(targets);
    sql += `AND lower(email) = ANY($${params.length}::text[]) `;
  }
  params.push(Math.min(LIMIT * 10, 2000));
  sql += `ORDER BY id ASC LIMIT $${params.length}`;

  const { rows } = await pool.query(sql, params);

  // Everyone already invited (any run) is skipped, not just this run's.
  const { rows: sentRows } = await pool.query(
    "SELECT DISTINCT lower(user_email) AS email FROM email_events " +
      "WHERE type = $1 AND status = 'sent'",
    [REVIEW_INVITE_TYPE],
  );
  const alreadyInvited = new Set(sentRows.map((row) => String(row.email ?? "").toLowerCase()));

  const eligible = [];
  const skipped = { notEligible: 0, alreadyInvited: 0, excluded: 0 };

  for (const row of rows) {
    const email = String(row.email ?? "").toLowerCase();
    if (EXCLUDED_EMAILS.has(email)) {
      skipped.excluded += 1;
      continue;
    }
    if (alreadyInvited.has(email)) {
      skipped.alreadyInvited += 1;
      continue;
    }
    if (
      !isReviewInviteEligible({
        clerkId: row.clerk_id,
        email: row.email,
        name: row.name,
        age: row.age,
        notificationPrefs: row.notification_prefs,
      })
    ) {
      skipped.notEligible += 1;
      continue;
    }
    eligible.push(row);
    if (eligible.length >= LIMIT) break;
  }

  console.log(
    `Trustpilot review invitations — ${SEND ? "SENDING" : "DRY RUN (nothing is sent)"}`,
  );
  console.log(
    `Scanned ${rows.length} player account(s); ${eligible.length} recipient(s) selected.`,
  );
  console.log(
    `Skipped: ${skipped.alreadyInvited} already invited, ` +
      `${skipped.notEligible} not eligible (opt-out/minor/bad address), ` +
      `${skipped.excluded} excluded.`,
  );

  if (eligible.length === 0) {
    console.log("\nNothing to send.");
  } else {
    console.log("\nRecipients:");
    for (const row of eligible) {
      console.log(`  #${row.id}  ${maskEmail(row.email)}`);
    }
  }

  if (!SEND) {
    console.log(
      "\nDRY RUN — no email was sent. Re-run with --send to contact these recipients.",
    );
    process.exit(0);
  }

  let sent = 0;
  let failed = 0;
  const reasons = new Map();

  for (const row of eligible) {
    const result = await sendReviewInvite({
      clerkId: row.clerk_id,
      email: row.email,
      name: row.name,
    });
    if (result?.sent) {
      sent += 1;
      console.log(`  sent  ${maskEmail(row.email)}`);
    } else {
      failed += 1;
      const reason = String(result?.reason ?? "unknown");
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      console.log(`  skip  ${maskEmail(row.email)} — ${reason}`);
    }
    // Gentle pacing keeps a large batch from tripping the provider's rate limit.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  console.log(`\nDone: ${sent} sent, ${failed} not sent.`);
  if (reasons.size > 0) {
    console.log(
      "Reasons: " +
        [...reasons.entries()].map(([reason, count]) => `${reason}=${count}`).join(", "),
    );
  }
  console.log(
    "Trustpilot sends its own invitation from each BCC copy; allow their " +
      "system a few minutes before the review requests appear.",
  );
} catch (error) {
  console.error("[trustpilot-invites] Failed:", error?.message ?? error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
