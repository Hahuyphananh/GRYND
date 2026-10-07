import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";

/**
 * The help surface (/faq).
 *
 * ── Why this is a SERVER component ────────────────────────────────────────
 *
 * It used to be a client component whose answers lived inside a framer-motion
 * accordion, which meant only the OPEN answer was present in the HTML response.
 * A visitor who had not clicked, a crawler and a screen reader all saw a page
 * of questions with almost no answers — the opposite of a useful help page.
 *
 * The answers below are rendered with native <details>/<summary>, so every
 * question AND its full answer is in the HTML for everyone, and the collapsible
 * behaviour still works with no JavaScript at all. Nothing here needs client
 * state, so nothing here is deferred to the browser.
 *
 * ── Why the answers changed ───────────────────────────────────────────────
 *
 * The previous copy described a staked token economy — "PvP matches stake
 * tokens", "the winner takes 1.9× their stake", "a 5% platform fee". None of
 * that is true any more: STAKES ARE RETIRED (src/lib/games/stakes.js), a match
 * costs nothing to enter and moves no tokens, and a ranked result instead moves
 * that game's own Elo rating and trophy ladder. A help page that contradicts
 * the product is worse than no help page, so every answer here is written
 * against the current implementation.
 *
 * ── The game links ────────────────────────────────────────────────────────
 *
 * `helpGames` is `[{ slug, name }]` for the games this page points at, resolved
 * from the game catalogue by app/faq/page.jsx and rendered as the "Where to
 * start" block below — real links in the HTML, never buried in a collapsed
 * answer.
 */
const faqSections = [
  {
    category: "Getting started",
    questions: [
      {
        q: "What is GRYND?",
        a: (
          <>
            GRYND is a collection of competitive, one-versus-one skill games played in the browser.
            Every match is a real duel against another player, results feed a per-game rating and a
            trophy ladder, and every game has its own page that explains the rules, the scoring and
            the strategy before you commit to a match.{" "}
            <Link href="/games" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Browse the full catalogue
            </Link>{" "}
            to see what is available.
          </>
        ),
      },
      {
        q: "Do I need an account to play?",
        a: "You can read the game pages, the guides and the leaderboards without signing in. Playing a ranked match needs a free account, because your results have to be attached to a rating. Creating one takes a minute and asks for the basics plus your date of birth, since GRYND is an 18+ platform.",
      },
      {
        q: "How much does GRYND cost?",
        a: (
          <>
            Playing is free. A match costs nothing to enter and nothing is wagered or paid out — see{" "}
            <Link href="/fair-play" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              the Fair Play Policy
            </Link>
            . There is an optional GRYND PRO membership that removes ads and adds advanced statistics
            and match history, and it deliberately does not change matchmaking, ratings or rewards.
          </>
        ),
      },
      {
        q: "How do I play my first match?",
        a: "Open the games hub, pick a game and read its page — the rules, how it scores and how the winner is decided are all there. Then press Play. You can start with a free practice match against the bot to learn the controls, or go straight into a ranked duel. Both use the same board and the same rules.",
      },
    ],
  },
  {
    category: "Matches and matchmaking",
    questions: [
      {
        q: "How does matchmaking work?",
        a: "When you press Play you join a queue for that game. The queue looks for the closest available opponent by skill — that game's own rating and trophy level — and widens the search the longer you wait so you are never stuck behind a perfect match that does not exist. If nobody appears, a bot practice match is always available with no wait.",
      },
      {
        q: "What is the difference between bot practice and a ranked match?",
        a: "Practice matches against the bot are unrated: they are there so you can learn a board or rehearse a specific situation, and they do not change your rating, your trophies or the leaderboards. Ranked matches are the real thing — the result moves that game's rating and trophy ladder for both players. Nothing is at stake in either case but the result.",
      },
      {
        q: "Do I play against real people?",
        a: "Yes. Ranked matches are 1v1 against another player. GRYND does not fill ranked queues with bots to hide an empty lobby — if a match is against the bot, it is labelled as practice rather than presented as a duel.",
      },
      {
        q: "What happens if I disconnect or leave mid-match?",
        a: "The match resolves according to that game's own resign and forfeit rules, which are stated on the game's page. Because every game is server-authoritative, the state is held by the server rather than your browser, so reconnecting usually restores the match where it stood. If you are unsure what happened, check the match result before starting another one.",
      },
    ],
  },
  {
    category: "Rating, trophies and leaderboards",
    questions: [
      {
        q: "How does progression work?",
        a: (
          <>
            Every game keeps its own numbers. A ranked result moves an Elo-style{" "}
            <strong className="text-[#c9f7ff]">rating</strong> for that game and its{" "}
            <strong className="text-[#c9f7ff]">trophy ladder</strong>, so progress in one game never
            drags another one down. There is no paid track: the cosmetics and profile options are
            available to every player, and nothing purchasable changes how a match is decided.
          </>
        ),
      },
      {
        q: "How are the leaderboards built?",
        a: (
          <>
            The{" "}
            <Link href="/classement" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              rankings page
            </Link>{" "}
            has a board per game and an overall board, ranking players by wins and by trophies. There
            is also a weekly board that resets so everyone gets a fresh shot at the top. Boards are
            computed from real match results only — no invented positions and no placeholder rows.
          </>
        ),
      },
      {
        q: "Why did my rating move so much after one match?",
        a: "Ratings move more when there is less certainty about where a player belongs. A brand-new ladder or a player with few results will move a long way on a single match; an established rating moves in smaller steps because the system already knows roughly where that player sits. Over enough matches the movement settles down.",
      },
    ],
  },
  {
    category: "Games, rules and modes",
    questions: [
      {
        q: "Are the games skill-based or luck?",
        a: (
          <>
            Both, in different proportions, and each game is honest about which. Some are pure
            perfect-information duels where nothing is hidden or drawn; others are built around a
            random input that both players face equally and manage with decisions. What every game
            has in common is that both seats play under the same rules, and a per-game rating exists
            so that over many matches the better player comes out ahead. The{" "}
            <Link href="/guides" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              guides
            </Link>{" "}
            go into this properly.
          </>
        ),
      },
      {
        q: "Where can I find the rules for a specific game?",
        a: "Every game has its own public page covering how to play, the rules the server enforces, how the winner is decided, strategy hints and a short FAQ. Start from the games hub and open the game you are curious about.",
      },
      {
        q: "Is every game 1v1?",
        a: "Yes. GRYND is a duel platform: one opponent, one result, one rating. Games range from a few seconds to a long turn-based match, but none of them seat more than two players.",
      },
    ],
  },
  {
    category: "Your account, profile and history",
    questions: [
      {
        q: "Where do I see my stats and match history?",
        a: (
          <>
            Your{" "}
            <Link href="/profil" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              profile page
            </Link>{" "}
            shows your recent matches and your record across the games you have played, and other
            players can see a public version of it. Ratings and trophy positions live on the
            rankings page.
          </>
        ),
      },
      {
        q: "How do referrals work?",
        a: "Every account has a referral code. When someone you invited redeems it, it is recorded on your profile and you receive a referral bonus; the code can only be redeemed once per account and you cannot refer yourself. Building a referral streak can also unlock special profile titles.",
      },
      {
        q: "Why is my review still pending?",
        a: "Every review is read by a human before it appears publicly, so there is a delay between submitting one and seeing it live. Until then it shows as pending on your end. Approved reviews appear on the reviews page with a Verified player badge.",
      },
      {
        q: "How do I delete my account?",
        a: (
          <>
            You can request deletion from your profile. It is a genuine erasure: your account and its
            data are removed, including your login.{" "}
            <Link href="/privacy-policy" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              The Privacy Policy
            </Link>{" "}
            lists exactly what is stored and how deletion works.
          </>
        ),
      },
    ],
  },
  {
    category: "Tokens",
    questions: [
      {
        q: "Do matches use tokens?",
        a: "No. A match costs nothing to enter and cannot move tokens in either direction — there is no stake, no pot and no fee. Competitive results are rewarded with that game's rating movement and trophies instead. Tokens are a leftover virtual currency with no role in a match.",
      },
      {
        q: "Can I buy, sell or withdraw tokens?",
        a: "No. Tokens have no real-world monetary value and cannot be exchanged for cash or anything of real value, and there is no purchase option. Nothing on GRYND is a financial product — it is a place to compete.",
      },
    ],
  },
  {
    category: "Fair play and support",
    questions: [
      {
        q: "How do I know the games are fair?",
        a: (
          <>
            Games are server-authoritative, randomness where it exists is generated on the server
            rather than in your browser, and results are recorded from the server's own state.
            Automated monitoring looks for cheating and every report is investigated. The{" "}
            <Link href="/fair-play" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Fair Play Policy
            </Link>{" "}
            sets out exactly what that means.
          </>
        ),
      },
      {
        q: "Something is not working — what should I try first?",
        a: "Refresh the page once, then confirm you are on the latest browser and not running an extension that blocks scripts. Game state is held server-side, so a reload normally restores your match instead of losing it. If it still fails, the contact page reaches the team that runs the platform.",
      },
      {
        q: "How do I report a player or a bug?",
        a: (
          <>
            Players can be reported from inside a match and from the leaderboard rows, and both paths
            go to a monitored admin inbox. For anything else — a broken board, a wrong result, a
            question the help pages do not answer — use the{" "}
            <Link href="/contact" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              contact page
            </Link>
            .
          </>
        ),
      },
    ],
  },
];

// Native <details> gives us a collapsible answer that is still fully present in
// the HTML when closed — no client state, no accordion that hides content from
// crawlers, and it works with JavaScript disabled.
function FaqItem({ q, a }) {
  return (
    <details className="group rounded-lg border border-[#00e5ff]/15 bg-[#040d24]/60 backdrop-blur-sm transition-all hover:border-[#00e5ff]/30 open:border-[#00e5ff]/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]">
        <h3 className="text-base font-semibold text-[#c9f7ff]">{q}</h3>
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/40 text-[#00e5ff] transition-transform duration-300 group-open:rotate-45"
          aria-hidden="true"
        >
          +
        </span>
      </summary>
      <div className="px-6 pb-5 leading-relaxed text-[#c9f7ff]/90">{a}</div>
    </details>
  );
}

export default function FaqPage({ helpGames = [] }) {
  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />

      <NavigationBar currentPath="/faq" />

      <div className="mx-auto max-w-4xl px-4 py-16">
        <div>
          <h1 className="mb-4 text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b]">
            Frequently Asked Questions
          </h1>
          <p className="mb-8 text-lg text-[#9dd8ff]">
            How GRYND works: accounts, matches, matchmaking, ratings and trophies, game rules,
            profiles and support. Every answer below is open to read in full — nothing is hidden
            behind an interaction. Can&apos;t find your answer?{" "}
            <Link href="/contact" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Contact us
            </Link>
            .
          </p>
        </div>

        {faqSections.map((section) => (
          <div key={section.category} className="mb-10">
            <h2 className="mb-4 text-xl font-bold text-[#00e5ff]">{section.category}</h2>
            <div className="space-y-3">
              {section.questions.map((item) => (
                <FaqItem key={item.q} q={item.q} a={item.a} />
              ))}
            </div>
          </div>
        ))}

        {/* Where to start — the answers above describe every game on GRYND, so
            this is the natural place to name a few and link to their pages.
            Rendered as plain <Link>s in the HTML: no accordion, no state. */}
        {helpGames.length > 0 && (
          <section
            id="faq-games-heading"
            aria-labelledby="faq-games-heading"
            className="mt-10 rounded-lg border border-[#00e5ff]/20 bg-[#00e5ff]/5 p-6"
          >
            <h2 className="text-xl font-bold text-[#00e5ff]">Where to start</h2>
            <p className="mt-2 text-sm leading-relaxed text-[#c9f7ff]/80">
              Everything above applies to every game on GRYND. If you are deciding what to play
              first, these five cover the range — a pure strategy game, a pure reflex game, a
              memory game, a game with a genuine chance element, and the shortest match on the
              site. Each one has its own page with the rules, the scoring and the strategy.
            </p>
            <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {helpGames.map((game) => (
                <li key={game.slug}>
                  <Link
                    href={`/games/${game.slug}`}
                    className="text-[#00e5ff] underline hover:text-[#f5ff3b]"
                  >
                    {game.name} rules and strategy
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-[#c9f7ff]/80">
              Or{" "}
              <Link href="/games" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                browse all games
              </Link>{" "}
              to compare them side by side. How matches are kept fair is documented in the{" "}
              <Link href="/fair-play" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                Fair Play Policy
              </Link>
              .
            </p>
          </section>
        )}

        <div className="mt-10 rounded-lg border border-[#f5ff3b]/20 bg-[#f5ff3b]/5 p-6 text-center">
          <p className="text-sm text-[#c9f7ff]/70">
            Still have questions? Our team is one message away —{" "}
            <Link href="/contact" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              get in touch
            </Link>
            .
          </p>
        </div>
      </div>

      <Footer />
    </div>
  );
}
