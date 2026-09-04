"use client";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import { motion } from "framer-motion";
import Link from "next/link";

const sections = [
  {
    title: "1. Acceptance of Terms",
    content: [
      "By creating an account or using GRYND in any way, you confirm that you have read, understood, and agree to be bound by these Terms & Conditions, together with our Privacy Policy and Fair Play Policy. If you do not agree with any part of these terms, you must not use our platform. These terms constitute a legally binding agreement between you and GRYND.",
    ],
  },
  {
    title: "2. Eligibility",
    content: [
      "You must be at least 18 years old (or the legal age of majority in your jurisdiction) to use GRYND. By using our platform, you represent and warrant that you meet this age requirement, and you authorize us to verify your age (including through the date of birth you provide). It is your responsibility to ensure that your use of GRYND complies with all applicable laws in your jurisdiction. We reserve the right to deny access to users who do not meet eligibility requirements.",
    ],
  },
  {
    title: "3. Account Registration",
    content: [
      "When creating an account, you must provide accurate, current, and complete information. You are solely responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You agree to notify us immediately of any unauthorized use of your account. We are not liable for any loss or damage arising from your failure to protect your account. Accounts are personal to you: you may not sell, transfer, or share your account.",
    ],
  },
  {
    title: "4. Virtual Tokens & Transactions",
    content: [
      "GRYND uses virtual tokens for gameplay. Tokens have no real-world monetary value and are not redeemable, withdrawable, or exchangeable for cash or any other form of currency, now or in the future.",
      "If token purchases are made available, they are processed by a third-party payment processor and credited to your account once the payment is confirmed. Purchased tokens are non-refundable except where required by law or where we otherwise determine a refund is appropriate. We do not store your payment instrument details.",
      "We reserve the right to modify, suspend, or terminate the token system at any time. Token balances displayed in your account are final and binding. Any attempt to manipulate, exploit, or abuse the token system, or to obtain tokens by unauthorized means, may result in forfeiture of tokens and account suspension.",
    ],
  },
  {
    title: "5. Skill-Based Gaming",
    content: [
      "GRYND offers skill-based games where outcomes are determined primarily by player skill, strategy, and decision-making rather than chance. Results are determined through fair and transparent game mechanics. We reserve the right to review game outcomes and investigate suspicious activity. In cases of technical errors or platform malfunctions, we may void games and refund tokens at our discretion.",
    ],
  },
  {
    title: "6. Prohibited Conduct",
    content: [
      "You agree not to: (a) use automated scripts, bots, or any form of automation to play games; (b) exploit bugs, glitches, or errors in the platform; (c) engage in collusion, chip dumping, or any form of cheating; (d) create multiple accounts for any reason; (e) harass, threaten, or abuse other users; (f) use offensive, inappropriate, or prohibited usernames, profile content, or chat messages; (g) attempt to access or modify another user's account; (h) submit false or misleading reviews or reports; or (i) resell, transfer, or otherwise commercialize your account or tokens.",
    ],
  },
  {
    title: "7. Fair Play & Anti-Cheating",
    content: [
      "We are committed to maintaining a fair gaming environment. Our systems monitor for suspicious patterns and potential cheating. Users found violating fair play rules may face consequences including warning, token forfeiture, temporary suspension, or permanent account ban. We employ both automated detection systems and manual review processes to ensure fair play. See our Fair Play Policy for details.",
    ],
  },
  {
    title: "8. User Content & Community",
    content: [
      "User-generated content (\"UGC\") is any content you create, upload, or transmit on the platform, including without limitation chat messages, usernames and display names, avatar icons, profile customizations, emotes, reviews, gameplay clips or replays, and reports or feedback you submit.",
      "You retain ownership of the content you submit, and you grant GRYND a non-exclusive, worldwide, royalty-free, sublicensable, and transferable license to host, store, display, reproduce, modify (solely to the extent needed to operate the platform, such as resizing or filtering), distribute, and transmit that content on and through the platform, and to grant other users the limited right to view and interact with it as the platform permits (for example, approved reviews are shown on the reviews page and homepage, and large wins appear in the Big Wins feed). This license ends when you delete your content or account, except where the content has already been shared with other users or is needed to comply with law.",
      "You represent and warrant that: (a) you own or have all necessary rights to the UGC you submit; (b) your UGC does not infringe, misappropriate, or violate the rights of any third party, including intellectual property, privacy, or publicity rights; and (c) your UGC is not unlawful, defamatory, obscene, hateful, harassing, or otherwise prohibited by Section 6.",
      "All UGC is subject to moderation, and GRYND may monitor, review, refuse, remove, hide, or edit any UGC at any time, with or without notice and for any reason, including where we reasonably believe it violates these Terms, our Fair Play Policy, or applicable law. Chat messages are retained for a limited period for moderation, safety, and dispute-resolution purposes even after deletion on your end, and deleted messages may remain visible to recipients who already received them.",
      "If you believe content on the platform infringes your rights, contact us and we will review the request promptly. Users who repeatedly breach community standards may have content removed and may be suspended or permanently banned.",
    ],
  },
  {
    title: "9. Communications",
    content: [
      "By creating an account, you agree to receive transactional emails (account and service notices) and, where permitted by law, marketing and reactivation emails. You can opt out of marketing emails at any time by contacting us; transactional emails are necessary for the service to function.",
    ],
  },
  {
    title: "10. Intellectual Property",
    content: [
      "All content on GRYND, including but not limited to logos, designs, text, graphics, software, and game mechanics, is the intellectual property of GRYND or our licensors. You may not reproduce, distribute, modify, or create derivative works without our express written consent. The GRYND name and logo are proprietary trademarks.",
    ],
  },
  {
    title: "11. Limitation of Liability",
    content: [
      "To the maximum extent permitted by applicable law, in no event shall GRYND, its affiliates, and their respective officers, directors, employees, agents, or licensors be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or for any loss of profits, revenue, data, goodwill, or business opportunity, arising out of or in connection with your use of, or inability to use, the platform, including without limitation damages caused by bugs, errors, downtime, service interruptions, data loss, or platform crashes. Our total aggregate liability to you for all claims arising out of or relating to these Terms or your use of the platform, whether in contract, tort (including negligence), or otherwise, shall not exceed the amount of tokens in your account at the time the claim arises. Because tokens have no real-world monetary value and are not redeemable for cash, this cap reflects the limited nature of the services we provide. Some jurisdictions do not allow the exclusion or limitation of certain damages, so some of the above exclusions or limitations may not apply to you.",
    ],
  },
  {
    title: "12. Disclaimer of Warranties",
    content: [
      "THE PLATFORM IS PROVIDED ON AN \"AS IS\" AND \"AS AVAILABLE\" BASIS, WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE PLATFORM WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS, NOR DO WE WARRANT THE ACCURACY, RELIABILITY, OR COMPLETENESS OF ANY CONTENT OR RESULTS OBTAINED THROUGH THE PLATFORM. ANY CONTENT YOU ACCESS OR DOWNLOAD FROM THE PLATFORM IS AT YOUR OWN RISK, AND YOU ARE SOLELY RESPONSIBLE FOR ANY DAMAGE TO YOUR DEVICE OR LOSS OF DATA RESULTING THEREFROM. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED. SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OF CERTAIN WARRANTIES, SO SOME OF THE ABOVE EXCLUSIONS MAY NOT APPLY TO YOU.",
    ],
  },
  {
    title: "13. Indemnification",
    content: [
      "You agree to indemnify, defend, and hold harmless GRYND, its affiliates, and their respective officers, directors, employees, agents, and licensors from and against any and all claims, demands, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or in connection with: (a) your use of the platform; (b) your violation of these Terms; (c) your violation of any applicable law or regulation; or (d) your infringement of any third-party rights, including intellectual property or privacy rights. We reserve the right, at your expense, to assume the exclusive defense and control of any matter for which you are required to indemnify us, and you agree to cooperate with our defense of such claims.",
    ],
  },
  {
    title: "14. Termination",
    content: [
      "We reserve the right to suspend or terminate your account at any time, with or without cause, including for violation of these Terms. Upon termination, your right to use the platform immediately ceases. You may delete your account at any time through your profile settings; see our Privacy Policy for what happens to your data after deletion. Sections that by their nature should survive termination, including Limitation of Liability, Disclaimer of Warranties, Indemnification, and Governing Law & Disputes, will survive termination of these Terms.",
    ],
  },
  {
    title: "15. Privacy",
    content: [
      "Our collection and use of your personal information is described in our Privacy Policy, which forms part of these Terms and explains in detail what we collect and why. By using the platform you also agree to the practices described there.",
      "In summary, we collect and process only the data needed to run the service: account information (email address, date of birth for age verification, and profile settings), gameplay records (including token balances, match history, and chat messages), technical and analytics data (device, browser, and usage diagnostics), and communications you send us (such as support requests).",
      "We use this data to operate the platform, verify eligibility, keep the games fair and free of cheating or abuse, process disputes, provide support, and — where permitted by law — send you service and marketing communications you can opt out of. We do not sell your personal information.",
      "Your data is stored on secure servers and protected in transit and at rest. Some service providers (for example, payment processors, hosting providers, and analytics tools) may process data on our behalf under contractual safeguards, and some of your data may be stored or processed outside your country of residence, including in Canada and the United States, where it remains subject to the protections described in these Terms and the Privacy Policy.",
      "We keep personal data only as long as needed for the purposes described above or as required by law; see the Data Retention section of our Privacy Policy for details. You may request access to, correction of, export of, or deletion of your personal information at any time through your account settings or by contacting us, subject to legal and security obligations.",
    ],
  },
  {
    title: "16. Changes to Terms",
    content: [
      "We may modify these Terms & Conditions at any time. Material changes will be communicated via email or through a notice on our platform. Your continued use of GRYND after changes take effect constitutes your acceptance of the new terms. If you do not agree with changes, you should stop using the platform and delete your account.",
    ],
  },
  {
    title: "17. Governing Law & Disputes",
    content: [
      "These Terms & Conditions and any dispute arising out of or relating to them, or to your use of the platform, shall be governed by and construed in accordance with the laws of the Province of Quebec and the federal laws of Canada applicable therein, without regard to conflict-of-laws principles.",
      "Informal resolution first: any dispute, claim, or controversy arising out of or relating to these Terms or the platform (each a \"Dispute\") shall first be resolved through good-faith negotiations between the parties. Before starting arbitration or any court proceeding, the complaining party must send written notice describing the Dispute to the other party, and the parties must attempt to resolve it within thirty (30) days of that notice.",
      "Binding arbitration: if a Dispute is not resolved within that thirty (30) day period, it shall be resolved by final and binding individual arbitration administered in the Province of Quebec, Canada, under the applicable arbitration rules in effect at that time. The arbitration will be conducted in English by a single arbitrator, and judgment on the arbitral award may be entered in any court of competent jurisdiction. Each party will bear its own costs and fees, subject to any right to recover them under applicable law or the applicable rules.",
      "Small claims: instead of arbitration, either party may bring an individual Dispute in a small claims court of competent jurisdiction in the Province of Quebec if the Dispute qualifies for that court.",
      "No class actions: you and GRYND agree that each party may bring Disputes only in its individual capacity, and neither may bring a Dispute as a plaintiff or class member in any class, collective, consolidated, or representative proceeding. The arbitrator may not consolidate or join the claims of more than one person and may not preside over any class or representative proceeding.",
      "Opt-out: you may opt out of the arbitration provision in this Section by sending written notice within thirty (30) days of first accepting these Terms; the notice must include your name, the email address on your account, and a statement that you are opting out of the arbitration provision of the Terms. If you opt out, Disputes will be resolved exclusively in the courts of the Province of Quebec.",
      "You agree to submit to the personal jurisdiction of the courts of the Province of Quebec for any matters not subject to arbitration and for the enforcement of any arbitration award. This Section does not affect any right to bring a Dispute before a consumer-protection authority where applicable law permits.",
    ],
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
            Last updated: September 3, 2026
          </p>

          <div className="mb-8 rounded-lg border border-[#00e5ff]/20 bg-[#040d24]/80 p-6 backdrop-blur-sm">
            <p className="leading-relaxed text-[#c9f7ff]">
              Welcome to GRYND. These Terms & Conditions govern your use of
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
            For questions about these terms,{" "}
            <Link
              href="/contact"
              className="text-[#f5ff3b] underline decoration-[#f5ff3b]/40 underline-offset-4 hover:text-[#f5ff3b]/80 transition-colors"
            >
              contact us
            </Link>
            .
          </p>
        </motion.div>
      </div>

      <Footer />
    </div>
  );
}
