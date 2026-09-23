/**
 * Google AdSense loader, for the pages we monetise: the home page, the game
 * hub, the leaderboard, the battlepass and the game lobbies.
 *
 * Deliberately NOT in the root layout. AdSense pays for impressions on the
 * pages a player browses *between* games, and an ad on a live board is both an
 * intrusion and a distraction from a wager in progress. So this is rendered
 * per page instead, and it is absent from:
 *
 *   - every match page (the `[matchId]` / `game/[gameId]` / `table/[tableId]`
 *     routes), and
 *   - the games whose lobby and board live in ONE page — Dice Flush and Odds
 *     today — because there is no lobby route to put it on that isn't also the
 *     board.
 *
 * The snippet is Google's, verbatim:
 *
 *   <script async
 *     src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4903728316211815"
 *     crossorigin="anonymous"></script>
 *
 * WHY THIS IS NOT GATED ON OUR OWN BANNER ANY MORE. It used to be: the tag was
 * only injected once the visitor accepted, which meant it was never in the
 * HTML we served. That was wrong twice over.
 *
 *   1. Google's certified CMP is delivered BY the AdSense tag — "your existing
 *      Google Publisher Tag or AdSense tag deploys user messages once the
 *      message is published in the relevant product"
 *      (https://developers.google.com/funding-choices/fc-api-docs). With the
 *      tag gated, EEA/UK/Swiss visitors could never be prompted at all, which
 *      is the exact revenue loss the certified-CMP requirement exists to
 *      prevent. No tag means no message means no consent means no ad.
 *   2. AdSense's site review reads the served HTML for `adsbygoogle.js`. A tag
 *      that only appears after a consent click is invisible to that crawler.
 *
 * Consent is NOT loosened by un-gating. The four Consent Mode signals start
 * denied (components/ConsentModeDefault.tsx), so until a consent source speaks
 * the ad requests carry no advertising cookie and no personalisation, and ad
 * click identifiers are redacted. Google's CMP then resolves consent for
 * EEA/UK/Swiss visitors and our own banner for everyone else.
 *
 * This is a server component with no client JavaScript: the tag has to be in
 * the initial HTML, not injected after hydration. React hoists `async` scripts
 * into <head>, deduplicated, so rendering it here lands it where Google
 * expects while still keeping it off the match pages.
 */
export const ADSENSE_CLIENT = "ca-pub-4903728316211815";

export default function AdSenseScript() {
  return (
    <script
      id="adsbygoogle-init"
      async
      crossOrigin="anonymous"
      src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}
    />
  );
}
