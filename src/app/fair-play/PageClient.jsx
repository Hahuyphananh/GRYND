"use client";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import { motion } from "framer-motion";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";

const sections = [
  {
    title: "Our Commitment to Fair Play",
    content: [
      "GRYND is built on the principle of fair competition. We are committed to providing a level playing field where all users can compete based on their skill, strategy, and decision-making abilities. We employ systems to detect and prevent unfair advantages, ensuring that every game is decided by merit alone.",
    ],
  },
  {
    title: "Anti-Cheating Measures",
    content: [
      "Our platform uses automated monitoring systems that analyze gameplay patterns for signs of cheating, collusion, or exploitation. This includes detection of automated scripts (bots), multi-accounting, real-time assistance from third parties, and any form of gameplay manipulation. Accounts flagged by our systems are subject to manual review by our moderation team.",
    ],
  },
  {
    title: "Prohibited Behavior",
    content: [
      "The following actions are strictly prohibited: using bots or automation tools; colluding with other players to manipulate outcomes; exploiting bugs, glitches, or errors; creating multiple accounts; sharing account credentials; using unauthorized third-party software to gain an advantage; intentionally stalling or delaying games; and any form of harassment or abuse toward other players.",
    ],
  },
  {
    title: "Consequences of Violations",
    content: [
      "Users found violating fair play rules face escalating consequences based on the severity and frequency of the violation. These may include: a formal warning, temporary suspension of account privileges, forfeiture of tokens or winnings obtained through unfair means, and permanent account suspension. All enforcement decisions are final.",
    ],
  },
  {
    title: "Reporting Suspicious Activity",
    content: [
      "We encourage our community to help maintain fair play by reporting suspicious behavior. If you believe another user is cheating, exploiting, or violating these rules, please report them through the platform's reporting feature or contact our support team through our contact page. All reports are investigated promptly and confidentially.",
    ],
  },
  {
    title: "Game Integrity & Randomness",
    content: [
      "For games that incorporate random elements, we use cryptographically secure, server-generated seeds to ensure unpredictable outcomes, and several games (such as Crash and Lane Runner) use provably-fair seed hashing so results can be verified after the fact. For skill-based games like Poker, Chess, Four-In-A-Row, and Pool, outcomes are determined purely by player decisions and skill. We regularly audit our game logic to ensure correctness and fairness.",
    ],
  },
  {
    title: "Responsible Gaming",
    content: [
      "GRYND is a free-to-play skill platform with virtual tokens that have no cash value — there is nothing to lose beyond your play time. We still encourage healthy habits: set limits on your play time, never chase losses, and take breaks when gaming stops being fun. If you feel your gaming is becoming problematic, you can pause your account at any time by contacting support, and you can permanently delete your account from your profile. We also send periodic inactivity reminders after long absences.",
    ],
  },
  {
    title: "Transparency & Accountability",
    content: [
      "We believe in transparency. Game rules, odds, and mechanics are clearly explained on our platform. We maintain logs of gameplay activity to ensure accountability, and our ranking and leaderboard systems use publicly documented formulas. If you have questions about how a particular game works, please consult the game instructions or contact support.",
    ],
  },
];

export default function FairPlayPage() {
  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />

      <NavigationBar currentPath="/" />

      <div className="mx-auto max-w-4xl px-4 py-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="mb-4 text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b]">
            Fair Play Policy
          </h1>
          <p className="mb-8 text-lg text-[#9dd8ff]">
            Last updated: August 25, 2026
          </p>

          <div className="mb-8 rounded-lg border border-[#00e5ff]/20 bg-[#040d24]/80 p-6 backdrop-blur-sm">
            <p className="leading-relaxed text-[#c9f7ff]">
              Fair play is at the heart of the GRYND experience. We are
              dedicated to ensuring that every game on our platform is fair,
              transparent, and enjoyable for all users. This policy outlines our
              standards, monitoring practices, and the consequences of violating
              fair play rules.
            </p>
          </div>
        </motion.div>

        <div className="space-y-6">
          {sections.map((section, index) => (
            <motion.div
              key={section.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: index * 0.05 }}
              className="rounded-lg border border-[#00e5ff]/15 bg-[#040d24]/60 p-6 backdrop-blur-sm transition-all hover:border-[#00e5ff]/30 hover:shadow-[0_0_15px_rgba(0,229,255,0.1)]"
            >
              <h2 className="mb-3 text-xl font-bold text-[#00e5ff]">
                {section.title}
              </h2>
              {Array.isArray(section.content) ? (
                <div className="space-y-2">
                  {section.content.map((paragraph, i) => (
                    <p
                      key={i}
                      className="leading-relaxed text-[#c9f7ff]/90"
                    >
                      {paragraph}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="leading-relaxed text-[#c9f7ff]/90">
                  {section.content}
                </p>
              )}
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.6 }}
          className="mt-10 rounded-lg border border-[#f5ff3b]/20 bg-[#f5ff3b]/5 p-6 text-center"
        >
          <p className="text-sm text-[#c9f7ff]/70">
            Play fair, have fun, and compete with honor. Together we make
            GRYND a great community.
          </p>
        </motion.div>
      </div>

      <Footer />
    </div>
  );
}
