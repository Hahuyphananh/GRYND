"use client";

import { useState } from "react";
import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import { motion, AnimatePresence } from "framer-motion";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";

const faqSections = [
  {
    category: "Getting Started & Tokens",
    questions: [
      {
        q: "What are tokens, and do they cost money?",
        a: "Tokens are GRYND's virtual in-game currency. You start with 1,000 free tokens when you create your account. Tokens have no real-world monetary value and are not redeemable for cash — they exist purely for playing and competing on the platform.",
      },
      {
        q: "How do I earn more tokens?",
        a: (
          <>
            There are several ways to grow your balance: claim your{" "}
            <Link href="/profil" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              daily login reward
            </Link>{" "}
            and build your streak for bigger bonuses, win skill-based games, earn referral bonuses
            when friends join through your code, and pick up comeback bonuses if you take a break.
            Higher VIP levels also unlock better rewards as you play.
          </>
        ),
      },
      {
        q: "Can I withdraw or buy tokens?",
        a: "No. Tokens are a virtual, play-only currency — they cannot be withdrawn or exchanged for cash or anything of real-world value. Token purchases are not currently available; if a purchase option is ever added, it will be processed by a trusted third-party payment provider and remain non-refundable virtual credits.",
      },
      {
        q: "What data does GRYND collect about me?",
        a: (
          <>
            We collect only what is needed to run the platform: your account details (name, email, date of
            birth for age verification), gameplay data (balances, games played, stats), content you submit
            (chat messages, reviews, contact messages), and — with your consent — analytics and error
            reporting. We never sell your data. The full list is in our{" "}
            <Link href="/privacy-policy" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Privacy Policy
            </Link>
            .
          </>
        ),
      },
    ],
  },
  {
    category: "Gameplay",
    questions: [
      {
        q: "Are the games skill-based or luck?",
        a: "GRYND games are skill-based. Outcomes are decided by your decisions, strategy, and reactions — not by a house edge or random chance. This is a core promise of the platform, and it's why every game shows its rules and mechanics up front.",
      },
      {
        q: "What's the difference between playing vs AI and PvP?",
        a: "Playing against AI (fun mode) wagers no tokens — it's free practice. PvP matches stake tokens against a real opponent. In PvP duels, the winner takes 1.9× their stake and the house keeps 0.1× as a platform fee. Draws refund both players.",
      },
      {
        q: "How do leaderboards and rankings work?",
        a: (
          <>
            Leaderboards rank players by skill across several categories — wins, all-time performance,
            and daily/weekly streaks. Rankings update as you play, and the weekly board resets so
            everyone gets a fresh shot. You can browse them on the{" "}
            <Link href="/classement" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Rankings
            </Link>{" "}
            page.
          </>
        ),
      },
      {
        q: "What happens if I disconnect or leave mid-match?",
        a: "If you disconnect during a PvP match, the match resolves according to its resign/forfeit rules — typically a loss or a refund depending on the game and match state. Check the match status before starting a new game so you don't double-wager.",
      },
      {
        q: "What counts as a \u201cbig win\u201d?",
        a: "Wins of 1 million tokens or more are featured in the live Big Wins feed in the chat — a fun way to see the platform's biggest payouts as they happen.",
      },
    ],
  },
  {
    category: "Account & Profile",
    questions: [
      {
        q: "How do levels, titles, and streaks work?",
        a: "Your VIP level rises as your total wagered grows, unlocking milestone titles you can equip on your profile. Daily streaks build with consecutive daily logins — the longer the streak, the better the daily reward — and top streaks earn their own titles.",
      },
      {
        q: "How do referrals work?",
        a: "Share your referral code with friends. When they sign up and play, you earn referral bonuses tracked on your profile. It's one of the easiest ways to grow your token balance.",
      },
      {
        q: "Where do I see my bet history and stats?",
        a: (
          <>
            Your{" "}
            <Link href="/profil" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              profile page
            </Link>{" "}
            shows your full history across every game — bets, wins, losses, biggest win, win rate,
            and your level. Other players can view a public version of your history too.
          </>
        ),
      },
      {
        q: "Why is my review still \u201cpending\u201d?",
        a: "Every review is human-moderated before it appears publicly. Until an admin approves it, it shows as pending on your end. Approved reviews appear on the reviews page and homepage with a \u201cVerified player\u201d badge.",
      },
    ],
  },
  {
    category: "Trust & Support",
    questions: [
      {
        q: "How do I know the games are fair?",
        a: (
          <>
            Fair play is a core platform commitment. We run automated anti-cheating monitoring, use
            cryptographically secure random generation where randomness exists, audit game logic,
            and investigate every report. Full details are in our{" "}
            <Link href="/fair-play" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Fair Play Policy
            </Link>
            .
          </>
        ),
      },
      {
        q: "How do I delete my account?",
        a: (
          <>
            You can request full account deletion from your profile. Deletion is a true erasure — your
            account and data are permanently removed, including your login. See our{" "}
            <Link href="/privacy-policy" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Privacy Policy
            </Link>{" "}
            for exactly what we store and how deletion works.
          </>
        ),
      },
      {
        q: "Who do I contact if something breaks or I have a question?",
        a: (
          <>
            Use the{" "}
            <Link href="/contact" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Contact
            </Link>{" "}
            page. Messages go straight to our monitored admin inbox, and you can also report
            suspicious players directly through the platform's report feature.
          </>
        ),
      },
    ],
  },
];

function AccordionItem({ q, a, open, onToggle }) {
  return (
    <div className="rounded-lg border border-[#00e5ff]/15 bg-[#040d24]/60 backdrop-blur-sm transition-all hover:border-[#00e5ff]/30">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
      >
        <span className="text-base font-semibold text-[#c9f7ff]">{q}</span>
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/40 text-[#00e5ff] transition-transform duration-300 ${
            open ? "rotate-45" : ""
          }`}
          aria-hidden="true"
        >
          +
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="px-6 pb-5 leading-relaxed text-[#c9f7ff]/90">{a}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function FaqPage() {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />

      <NavigationBar currentPath="/faq" />

      <div className="mx-auto max-w-4xl px-4 py-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="mb-4 text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b]">
            Frequently Asked Questions
          </h1>
          <p className="mb-8 text-lg text-[#9dd8ff]">
            Everything you need to know about tokens, gameplay, and your account. Can&apos;t find
            your answer?{" "}
            <Link href="/contact" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              Contact us
            </Link>
            .
          </p>
        </motion.div>

        {faqSections.map((section, sectionIndex) => (
          <motion.div
            key={section.category}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: sectionIndex * 0.05 }}
            className="mb-10"
          >
            <h2 className="mb-4 text-xl font-bold text-[#00e5ff]">{section.category}</h2>
            <div className="space-y-3">
              {section.questions.map((item, itemIndex) => {
                const globalIndex = faqSections
                  .slice(0, sectionIndex)
                  .reduce((acc, s) => acc + s.questions.length, 0) + itemIndex;
                const open = openIndex === globalIndex;
                return (
                  <AccordionItem
                    key={item.q}
                    q={item.q}
                    a={item.a}
                    open={open}
                    onToggle={() => setOpenIndex(open ? null : globalIndex)}
                  />
                );
              })}
            </div>
          </motion.div>
        ))}

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-10 rounded-lg border border-[#f5ff3b]/20 bg-[#f5ff3b]/5 p-6 text-center"
        >
          <p className="text-sm text-[#c9f7ff]/70">
            Still have questions? Our team is one message away —{" "}
            <Link href="/contact" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              get in touch
            </Link>
            .
          </p>
        </motion.div>
      </div>

      <Footer />
    </div>
  );
}
