"use client";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import { motion } from "framer-motion";

const sections = [
  {
    title: "Information We Collect",
    content:
      "When you create an account on GoonBet, we collect personal information such as your name, email address, username, and date of birth (for age verification). We also collect profile pictures if you choose to upload one. Additionally, we collect game-related data including your game history, bet amounts, wins, losses, token balances, and gameplay statistics.",
  },
  {
    title: "How We Use Your Information",
    content:
      "We use your information to provide, maintain, and improve our gaming services. This includes processing your bets, calculating rankings and leaderboards, displaying your profile and game history, sending important account notifications, and detecting fraudulent or abusive behavior. We also use aggregated data for analytics and platform improvements.",
  },
  {
    title: "Age Verification & Compliance",
    content:
      "As a platform featuring skill-based games with real-money wagering mechanics, we are required to verify that all users are at least 18 years of age. Your date of birth is collected solely for this purpose and is stored securely. Users who fail age verification are denied access to the platform in compliance with applicable gambling regulations.",
  },
  {
    title: "Data Sharing & Third Parties",
    content:
      "We do not sell your personal information to third parties. We may share your data with trusted service providers who assist us in operating our platform (such as Clerk for authentication, Neon for database hosting, and analytics providers). These third parties are contractually obligated to protect your data and use it only for the services they provide to us.",
  },
  {
    title: "Data Retention",
    content:
      "We retain your personal information for as long as your account is active or as needed to provide you with our services. If you delete your account, we will delete or anonymize your personal data within 30 days, except where we are required by law to retain certain records (such as transaction history for tax or regulatory purposes).",
  },
  {
    title: "Your Rights",
    content:
      "You have the right to access, correct, or delete your personal data at any time through your account settings. You may also request a copy of your data, restrict processing, or object to certain data uses. To exercise these rights, please contact us at privacy@goonbet.com. We will respond to your request within 30 days.",
  },
  {
    title: "Cookies & Tracking",
    content:
      "We use essential cookies and similar technologies to maintain your session, remember your preferences, and ensure the security of your account. We do not use third-party tracking cookies for advertising purposes. You can control cookie settings through your browser preferences, though disabling essential cookies may affect platform functionality.",
  },
  {
    title: "Changes to This Policy",
    content:
      "We may update this Privacy Policy from time to time to reflect changes in our practices or legal requirements. We will notify you of material changes via email or through a notice on our platform. Your continued use of GoonBet after such changes constitutes your acceptance of the updated policy.",
  },
];

export default function PrivacyPolicyPage() {
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
            Privacy Policy
          </h1>
          <p className="mb-8 text-lg text-[#9dd8ff]">
            Last updated: May 24, 2026
          </p>

          <div className="mb-8 rounded-lg border border-[#00e5ff]/20 bg-[#040d24]/80 p-6 backdrop-blur-sm">
            <p className="leading-relaxed text-[#c9f7ff]">
              Your privacy matters to us. This Privacy Policy explains how
              GoonBet collects, uses, stores, and protects your personal
              information when you use our platform. By using GoonBet, you
              consent to the practices described in this policy.
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
            For privacy-related inquiries, contact us at{" "}
            <span className="text-[#f5ff3b]">contact@goonbet.dedyn.io</span>
          </p>
        </motion.div>
      </div>

      <Footer />
    </div>
  );
}
