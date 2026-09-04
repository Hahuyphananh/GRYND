"use client";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import { motion } from "framer-motion";
import Link from "next/link";

const sections = [
  {
    title: "Encryption in Transit & At Rest",
    content: [
      "All traffic between your device and our servers is encrypted in transit using TLS. Your personal data is stored on databases that encrypt data at rest (managed by our hosting providers). We also serve strict security headers (including HSTS in production) and a restrictive Content Security Policy.",
    ],
  },
  {
    title: "Account Security",
    content: [
      "Sign-in and session management are handled by Clerk, a dedicated authentication provider. We protect state-changing requests with same-origin CSRF checks and rate limiting on all API endpoints, and administrative surfaces additionally require a recent second-factor verification (via an HMAC-signed, 24-hour security cookie issued only after an email code, authenticator app, or passphrase check). Session tokens and security cookies are signed with HMAC-SHA256, and our logout flow revokes the session and clears authentication cookies and device storage.",
    ],
  },
  {
    title: "Payment & Token Integrity",
    content: [
      "Token balances are authoritative server-side. Purchased tokens (if enabled) enter a balance only through a signature-verified payment webhook: each event is authenticated with an HMAC signature and a replay-window timestamp, and idempotency keys ensure a retry can never double-credit. We do not store card numbers or other payment instrument details — payment processing is handled by third-party processors that are PCI DSS compliant, and direct client-driven balance changes are disabled.",
    ],
  },
  {
    title: "Infrastructure Security",
    content: [
      "Our platform runs on managed cloud infrastructure (Vercel) with a serverless Postgres database (Neon/Vercel Postgres) and a managed cache (Upstash Redis). We rely on our providers' network security, including DDoS protection, and we apply database row-level security and parameterized queries to prevent injection. Access to production systems is limited, and administrative actions are recorded in an audit log.",
    ],
  },
  {
    title: "Vulnerability Management",
    content: [
      "We take a defense-in-depth approach: automated security tests run as part of our CI (input validation, media sanitization, authorization checks, CSRF and rate-limit tests, and webhook signature verification), dependencies are pinned and kept updated, and security fixes are applied promptly. We regularly review our code and follow security best practices in the frameworks we use.",
    ],
  },
  {
    title: "Data Privacy & Retention",
    content: [
      "We collect only the minimum data necessary to provide our services, retain it only as long as needed, and delete or anonymize it when it is no longer required (including a routine retention sweep of finished match records and full erasure on account deletion). See our Privacy Policy for details. We log security events to detect unauthorized access, and we purge or anonymize personal data from those logs where required.",
    ],
  },
  {
    title: "Incident Response",
    content: [
      "We monitor our services for errors and anomalies (including Sentry and health checks) and respond to security incidents as they are identified. In the event of a data breach affecting your personal information, we will notify you and the relevant authorities as required by applicable law.",
    ],
  },
  {
    title: "Third-Party Security",
    content: [
      "We carefully vet the third-party services we rely on (authentication, hosting, database, caching, analytics, error monitoring, email, and support chat) and limit the data we share with them to what is necessary to provide our services. Our third-party agreements require appropriate data-protection safeguards.",
    ],
  },
];

export default function SecurityPolicyPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e]">
      <NavigationBar currentPath="/" />

      <div className="mx-auto max-w-4xl px-4 py-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="mb-4 text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b]">
            Security Policy
          </h1>
          <p className="mb-8 text-lg text-[#9dd8ff]">
            Last updated: September 4, 2026
          </p>

          <div className="mb-8 rounded-lg border border-[#00e5ff]/20 bg-[#040d24]/80 p-6 backdrop-blur-sm">
            <p className="leading-relaxed text-[#c9f7ff]">
              At GRYND, the security of your data and the integrity of our
              platform are our highest priorities. This Security Policy
              describes the measures we actually take to protect your
              information and maintain a secure gaming environment.
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
            If you have any security concerns or would like to report a
            vulnerability, please contact our security team through our{" "}
            <Link
              href="/contact"
              className="text-[#f5ff3b] underline decoration-[#f5ff3b]/40 underline-offset-4 hover:text-[#f5ff3b]/80 transition-colors"
            >
              contact page
            </Link>
            .
          </p>
        </motion.div>
      </div>

      <Footer />
    </div>
  );
}
