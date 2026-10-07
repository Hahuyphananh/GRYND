import Link from "next/link";
import { CATEGORY_GROUPS } from "../../lib/gameDiscovery";
import { GAME_LANDING_PAGES } from "../../lib/gameLandingPages";
import { GUIDE_INDEX, guidePath } from "../../lib/guides";

/**
 * The home page's explanatory content.
 *
 * The hero sells the idea in one line, and the sections below it are a tunnel
 * of buttons. Neither answers the questions a first-time visitor actually has:
 * what is this, how is it different, what can I play, how does competing work,
 * what do I get for winning, and what do I do first. This component answers
 * all six, in plain text.
 *
 * It is a SERVER component rendered into the homepage HTML, which matters for
 * two reasons: the text is present for a crawler and for a visitor with
 * JavaScript disabled, and none of it has to be serialised into the client
 * bundle the hero needs.
 *
 * Numbers come from the catalogue (GAME_LANDING_PAGES, CATEGORY_GROUPS) rather
 * than being typed here, so "every game" stays true when a game is added. Every
 * claim is about something the platform ships today: stakes are retired
 * (src/lib/games/stakes.js), so nothing is wagered and a result moves the
 * game's own rating and trophies instead.
 */
export default function HomeExplainer() {
  const gameCount = GAME_LANDING_PAGES.length;
  const categories = CATEGORY_GROUPS.map((group) => group.label);

  return (
    <section aria-labelledby="home-explainer-heading" className="mx-auto max-w-7xl px-4 pb-10">
      <div className="rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/70 p-6 backdrop-blur-sm sm:p-8">
        <h2
          id="home-explainer-heading"
          className="text-2xl font-black tracking-tight text-[#f5ff3b] sm:text-3xl"
        >
          What GRYND is
        </h2>

        <p className="mt-4 max-w-3xl leading-relaxed text-[#d8fbff]">
          GRYND is a set of {gameCount} competitive games played one-on-one in your browser. Every
          match is a real duel against another player or, if you prefer, an unrated practice match
          against the bot. There is no wagering and no entry cost: a match is decided by the rules,
          and the reward for winning is that you move up that game&apos;s own rating and trophy
          ladder.
        </p>
        <p className="mt-3 max-w-3xl leading-relaxed text-[#d8fbff]">
          The games deliberately test different things — deduction, memory, reaction, planning,
          execution under a clock — so &quot;good at GRYND&quot; is not one skill. Each game carries
          its own rating, which means a game you have never played starts you at the bottom of its
          ladder rather than dragging down the ones you are strong at.
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-lg font-black tracking-tight text-[#00e5ff]">
              What makes it different
            </h3>
            <ul className="mt-3 space-y-2">
              {[
                "Ranked matches are 1v1 against a real opponent — bots are labelled as practice rather than passed off as a duel.",
                "Free to play, with nothing wagered. GRYND PRO is an optional membership that never changes matchmaking, ratings or rewards.",
                "Every game is server-authoritative: the board, the timing and the result are held by the server, not by the browser.",
                "Progression is per game. Wins move that game's rating and trophies, and nowhere else.",
                "Rules, scoring and strategy are published for every game before you play it, not learned by losing.",
              ].map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-relaxed text-[#d8fbff]">
                  <span
                    aria-hidden="true"
                    className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5ff]"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-black tracking-tight text-[#00e5ff]">The games</h3>
            <p className="mt-3 text-sm leading-relaxed text-[#d8fbff]">
              {gameCount} games across {categories.length} categories: {categories.join(", ")}. They
              range from a match that resolves in seconds to a long turn-based game, and from pure
              perfect-information duels to games where the same random input is dealt to both
              players and the skill is in managing it.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-[#d8fbff]">
              Every game has its own page with the mechanics, the scoring table, strategy notes and
              a short FAQ.{" "}
              <Link href="/games" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                Browse all games
              </Link>{" "}
              or read{" "}
              <Link href="/guides" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                a guide on the skill you want to improve
              </Link>
              .
            </p>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-lg font-black tracking-tight text-[#00e5ff]">
              How competitive play works
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-[#d8fbff]">
              Press Play and you join that game&apos;s queue, which looks for the closest available
              opponent by rating and trophy level and widens the search the longer you wait. The
              rules are identical for both seats — nothing about a match favours the player who
              queued first, and nothing is decided by the client.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-[#d8fbff]">
              If you would rather learn a board first, every game offers an unrated practice match
              against the bot. Practice moves no rating and no trophies, so there is nothing to lose
              while you work out what the game actually demands.
            </p>
          </div>

          <div>
            <h3 className="text-lg font-black tracking-tight text-[#00e5ff]">
              How progression works
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-[#d8fbff]">
              A ranked result moves two things for that game: an Elo-style rating, which reflects
              who you beat and by how much, and a trophy ladder, which is the long-run measure of
              how far you have climbed.{" "}
              <Link href="/classement" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                The rankings page
              </Link>{" "}
              holds a board per game, an overall board and a weekly board that resets so everyone
              gets a fresh shot.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-[#d8fbff]">
              Ratings move more when the system is unsure where a player belongs, so a new ladder
              shifts quickly and an established one settles down. How matches are kept fair — and
              what happens to randomness — is set out in the{" "}
              <Link href="/fair-play" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                Fair Play Policy
              </Link>
              .
            </p>
          </div>
        </div>

        <div className="mt-8">
          <h3 className="text-lg font-black tracking-tight text-[#00e5ff]">How to get started</h3>
          <ol className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                title: "Create a free account",
                body: "An account is what carries your rating, trophies and match history. Browsing does not need one.",
              },
              {
                title: "Pick a game and read its page",
                body: "The mechanics, the scoring and the tips are all there, so your first match is not a guess.",
              },
              {
                title: "Try a bot practice match",
                body: "Unrated, instant, and the fastest way to learn a board before you queue for a real duel.",
              },
              {
                title: "Play ranked and climb",
                body: "Results move that game's rating and trophies. Play a second game and you start a second ladder.",
              },
            ].map((step, index) => (
              <li
                key={step.title}
                className="rounded-xl border border-[#00e5ff]/20 bg-[#061329] p-4"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 text-xs font-bold text-[#00e5ff]">
                  {index + 1}
                </span>
                <p className="mt-2 font-bold text-[#d8fbff]">{step.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-[#9dd8ff]">{step.body}</p>
              </li>
            ))}
          </ol>

          <p className="mt-5 text-sm text-[#9dd8ff]">
            Two places worth reading next:{" "}
            <Link href="/faq" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              the FAQ
            </Link>{" "}
            for matches, matchmaking and accounts, and the{" "}
            <Link href="/guides" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              guides library
            </Link>{" "}
            — currently {GUIDE_INDEX.length} guides, starting with{" "}
            <Link
              href={guidePath(GUIDE_INDEX[0].slug)}
              className="text-[#00e5ff] underline hover:text-[#f5ff3b]"
            >
              {GUIDE_INDEX[0].title}
            </Link>
            .
          </p>
        </div>
      </div>
    </section>
  );
}
