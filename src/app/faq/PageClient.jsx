import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import GameCard from "../../components/games/GameCard";
import { GAME_CARD_ART } from "../../components/games/gameCardArt";
import { FaqSidebarList, FaqSidebarRail } from "../../components/faq/FaqSidebar";

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
 * `gameCards` is the WHOLE catalogue, built on the server by app/faq/page.jsx
 * from src/lib/gameLandingPages.ts and rendered as the game directory at the
 * foot of this page with the SAME card element the casino lobby uses
 * (src/components/games/GameCard.jsx) — one card per game, each a real link to
 * that game's OWN page (/games/<slug>), never to the lobby (/games/<slug>/play)
 * and never buried in a collapsed answer. The card's artwork comes from the
 * shared registry (src/components/games/gameCardArt.js), so a game cannot be
 * drawn here with different art than the lobby gives it.
 *
 * The directory is four cards wide from `lg` and therefore sits OUTSIDE the
 * sidebar grid below: inside a 200px sidebar column the cards would be too
 * narrow to read.
 *
 * ── The section sidebar ───────────────────────────────────────────────────
 *
 * FaqSidebarRail / FaqSidebarList (src/components/faq/FaqSidebar.jsx) show the
 * reader which section they are in and jump them to any other. The rail is
 * stuck under the navbar on small screens; the list occupies the left column
 * from `lg`. Both are real anchors, so neither needs JavaScript to be usable.
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

/**
 * A section's anchor id, derived from its heading — so a sidebar link and the
 * heading it points at can never disagree. "Rating, trophies and leaderboards"
 * becomes "rating-trophies-and-leaderboards".
 */
function sectionId(category) {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The sidebar's contents: every answered section, then the game directory.
 *
 * Deliberately a MODULE-level constant: the client sidebar keys its observer
 * effect off this array, and a fresh array on every render would tear the
 * observer down and rebuild it each time.
 */
const SIDEBAR_ITEMS = [
  ...faqSections.map((section) => ({
    id: sectionId(section.category),
    label: section.category,
  })),
  { id: "faq-games-heading", label: "Every game" },
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

export default function FaqPage({ gameCards = [] }) {
  return (
    <div className="relative min-h-screen overflow-x-clip">
      <InteractiveCasinoBg variant="subtle" />

      <NavigationBar currentPath="/faq" />

      <div className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
        <header className="mb-6">
          <h1 className="mb-4 text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b] sm:text-4xl">
            Frequently Asked Questions
          </h1>
          <p className="text-base text-[#9dd8ff] sm:text-lg">
            How GRYND works: accounts, matches, matchmaking, ratings and trophies, game rules,
            profiles and support. Every answer below is open to read in full — nothing is hidden
            behind an interaction — and each game's own rules page is linked in the directory at
            the end of this page. The contents list follows where you are, and jumps you straight
            to a section. Can&apos;t find your answer?{" "}
            <Link href="/contact" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Contact us
            </Link>
            .
          </p>
        </header>

        {/* Contents. The rail sticks under the navbar on small screens; the list
            takes the left column from `lg`. Two elements, one state — a single
            element containing both could never stick, because `position: sticky`
            only moves while its PARENT still has room to scroll. */}
        <FaqSidebarRail items={SIDEBAR_ITEMS} />

        <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
          <FaqSidebarList items={SIDEBAR_ITEMS} />

          {/* The answers column. `minmax(0,1fr)` above is what stops a long
              answer from widening this column and pushing the cards out. */}
          <div>
            {faqSections.map((section) => (
              <section
                key={section.category}
                id={sectionId(section.category)}
                aria-labelledby={`${sectionId(section.category)}-heading`}
                className="mb-10 scroll-mt-28"
              >
                <h2
                  id={`${sectionId(section.category)}-heading`}
                  className="mb-4 text-xl font-bold text-[#00e5ff]"
                >
                  {section.category}
                </h2>
                <div className="space-y-3">
                  {section.questions.map((item) => (
                    <FaqItem key={item.q} q={item.q} a={item.a} />
                  ))}
                </div>
              </section>
            ))}

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
        </div>

        {/* ── Every game, and its own page ─────────────────────────────────
            One card per public game, drawn with the SAME card element as the
            casino lobby (src/components/games/GameCard.jsx), each linking to
            that game's OWN info page (/games/<slug>) — deliberately NOT the
            lobby (/games/<slug>/play), which sits behind a sign-in and carries
            no rules to read. The card is a real anchor on the server, so the
            whole catalogue is reachable from this page in the HTML before any
            JavaScript runs. Four per row from `lg`, which is why this section
            sits outside the sidebar grid. */}
        {gameCards.length > 0 && (
          <section
            id="faq-games-heading"
            aria-labelledby="faq-games-title"
            className="mt-14 scroll-mt-28"
          >
            <h2 id="faq-games-title" className="text-xl font-bold text-[#00e5ff] sm:text-2xl">
              Every game, and where its rules live
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#c9f7ff]/80">
              Everything above applies to every game on GRYND, and each one has its own page: the
              rules the server enforces, how the winner is decided, strategy hints and that
              game&apos;s own questions — all readable without an account. Open the game you are
              curious about.
            </p>
            <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
              {gameCards.map((card) => (
                <li key={card.slug} className="h-full">
                  <GameCard
                    game={{
                      href: card.href,
                      title: card.name,
                      description: card.shortDescription,
                      image: GAME_CARD_ART[card.slug],
                      imageClassName: "group-hover:scale-[1.03]",
                      leaderboardKey: card.leaderboardKey,
                    }}
                  />
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-[#c9f7ff]/80">
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
      </div>

      <Footer />
    </div>
  );
}
