"use client";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import { motion } from "framer-motion";

const sections = [
  {
    title: "1. Acceptance of Terms",
    content:
      "By creating an account or using GoonBet in any way, you confirm that you have read, understood, and agree to be bound by these Terms & Conditions. If you do not agree with any part of these terms, you must not use our platform. These terms constitute a legally binding agreement between you and GoonBet.",
  },
  {
    title: "2. Eligibility",
    content:
      "You must be at least 18 years old (or the legal age of majority in your jurisdiction) to use GoonBet. By using our platform, you represent and warrant that you meet this age requirement. It is your responsibility to ensure that your use of GoonBet complies with all applicable laws in your jurisdiction. We reserve the right to verify your age and suspend accounts that do not meet eligibility requirements.",
  },
  {
    title: "3. Account Registration",
    content:
      "When creating an account, you must provide accurate, current, and complete information. You are solely responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You agree to notify us immediately of any unauthorized use of your account. We are not liable for any loss or damage arising from your failure to protect your account.",
  },
  {
    title: "4. Virtual Tokens & Transactions",
    content:
      "GoonBet uses virtual tokens for gameplay. Tokens have no real-world monetary value and are not redeemable for cash or any other form of currency. We reserve the right to modify, suspend, or terminate the token system at any time. Token balances displayed in your account are final and binding. Any attempt to manipulate, exploit, or abuse the token system may result in account suspension.",
  },
  {
    title: "5. Skill-Based Gaming",
    content:
      "GoonBet offers skill-based games where outcomes are determined primarily by player skill, strategy, and decision-making rather than chance. Results are determined through fair and transparent game mechanics. We reserve the right to review game outcomes and investigate suspicious activity. In cases of technical errors or platform malfunctions, we may void games and refund tokens at our discretion.",
  },
  {
    title: "6. Prohibited Conduct",
    content:
      "You agree not to: (a) use automated scripts, bots, or any form of automation to play games; (b) exploit bugs, glitches, or errors in the platform; (c) engage in collusion, chip dumping, or any form of cheating; (d) create multiple accounts for any reason; (e) harass, threaten, or abuse other users; (f) use offensive, inappropriate, or prohibited usernames or profile content; (g) attempt to access or modify another user's account.",
  },
  {
    title: "7. Fair Play & Anti-Cheating",
    content:
      "We are committed to maintaining a fair gaming environment. Our systems monitor for suspicious patterns and potential cheating. Users found violating fair play rules may face consequences including warning, token forfeiture, temporary suspension, or permanent account ban. We employ both automated detection systems and manual review processes to ensure fair play.",
  },
  {
    title: "8. Intellectual Property",
    content:
      "All content on GoonBet, including but not limited to logos, designs, text, graphics, software, and game mechanics, is the intellectual property of GoonBet or our licensors. You may not reproduce, distribute, modify, or create derivative works without our express written consent. The GoonBet name and logo are proprietary trademarks.",
  },
  {
    title: "9. Limitation of Liability",
    content:
      "GoonBet is provided 'as is' without warranties of any kind, either express or implied. We are not liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the platform. Our total liability to you for any claims arising from your use of GoonBet is limited to the amount of tokens in your account at the time of the claim.",
  },
  {
    title: "10. Termination",
    content:
      "We reserve the right to suspend or terminate your account at any time, with or without cause, including for violation of these terms. Upon termination, your right to use the platform immediately ceases. We may delete your account data in accordance with our Privacy Policy. You may also delete your account at any time through your profile settings.",
  },
  {
    title: "11. Changes to Terms",
    content:
      "We may modify these Terms & Conditions at any time. Material changes will be communicated via email or through a notice on our platform. Your continued use of GoonBet after changes take effect constitutes your acceptance of the new terms. If you do not agree with changes, you should stop using the platform and delete your account.",
  },
  {
    title: "12. Governing Law",
    content:
      "These Terms & Conditions are governed by and construed in accordance with applicable laws. Any disputes arising from these terms or your use of GoonBet shall be resolved through binding arbitration. You agree to submit to the personal jurisdiction of the courts for the resolution of any disputes.",
  },
];

export default function TermsPage() {
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
            Terms & Conditions
          </h1>
          <p className="mb-8 text-lg text-[#9dd8ff]">
            Last updated: May 24, 2026
          </p>

          <div className="mb-8 rounded-lg border border-[#00e5ff]/20 bg-[#040d24]/80 p-6 backdrop-blur-sm">
            <p className="leading-relaxed text-[#c9f7ff]">
              Welcome to GoonBet. These Terms & Conditions govern your use of
              our skill-based gaming platform. Please read them carefully before
              creating an account or using any of our services.
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
              <p className="leading-relaxed text-[#c9f7ff]/90">
                {section.content}
              </p>
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
            For questions about these terms, contact us at{" "}
            <span className="text-[#f5ff3b]">contact@goonbet.dedyn.io</span>
          </p>
        </motion.div>
      </div>

      <Footer />
    </div>
  );
}
