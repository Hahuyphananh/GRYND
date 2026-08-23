# Review Moderation SOP

How to run the GRYND product review queue. Reviews appear on the public
wall (`/reviews` + homepage) **only after approval** — the queue is the
gate between a user submitting and the world seeing it.

## Where to moderate

Admin dashboard → **Reviews** tab → filter `pending` (default).

Each review shows: reviewer name/email, star rating, game tag, and text.
Buttons: **Approve**, **Reject**, **Delete**.

## Cadence

- Check the queue **daily** (it's your support channel too — a user who
  writes a review is engaged; a bad experience left pending is a missed
  signal).
- Target: all reviews decided within **48 hours** of submission.
- The `pending` count is the metric to watch — a growing queue means
  reviews are stuck invisible.

## Approve (goes public)

A review is approved when it is **genuine and not harmful** — this is a
low bar:

- Written by a real user (it is — it's tied to an account)
- Not spam, advertising, or gibberish
- Not containing private info (someone else's email, phone, address),
  links to malware, or obviously false claims about facts
- Not abusive/hateful content

**Do not reject honest negative reviews.** A 1★ review from a real player
is legitimate feedback and (legally) must be treated the same as a 5★.
Rejecting bad reviews is what gets platforms fined — and it destroys the
trust the "verified player" badge is built on. If a negative review is
factually wrong, you can reply to the user (contact page) instead of
hiding it.

## Reject (stays private)

Only reject for the hard reasons above: spam, abuse, private data, or
inauthentic content. When in doubt, **approve** — the "Delete" button is
always available later if a review turns out to be problematic.

## Delete (removed entirely)

- Rejected content that should not exist at all (e.g. a review that
  contains someone's personal data)
- A review that was approved by mistake and later found to be spam/abuse

Deleting removes the row (and the user's ability to resubmit is restored,
since the unique-per-user constraint frees up).

## Audit trail

Every action is written to `admin_audit_logs` (`admin_review_moderated` /
`admin_review_deleted`) automatically — no extra logging needed.

## Funnel note

Approval is also a marketing-funnel event (`review_approved` in PostHog).
If you approve everything instantly, that event fires instantly — which is
fine; if you want the funnel to show a realistic "published" lag, batch
moderation a few times a day rather than instantly.
