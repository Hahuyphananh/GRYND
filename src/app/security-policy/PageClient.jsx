"use client";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import { motion } from "framer-motion";

const sections = [
  {
    title: "Data Encryption",
    content:
      "GRYND employs industry-standard TLS 1.3 encryption for all data transmitted between your device and our servers. All sensitive user data, including financial transactions and personal information, is encrypted at rest using AES-256 encryption. We regularly audit our encryption practices to ensure compliance with the latest security standards.",
  },
  {
    title: "Account Security",
    content:
      "We implement multi-layered account security including secure session management via Clerk authentication, CSRF protection on all state-changing requests, and rate limiting on API endpoints to prevent brute-force attacks. Users are encouraged to enable strong passwords and never share their account credentials. Session tokens are signed using HMAC-SHA256 and automatically expire after periods of inactivity.",
  },
  {
    title: "Payment Security",
    content:
      "All virtual token transactions on GRYND are processed through secure, audited systems. We do not store raw payment instrument details on our servers. Financial data handled through integrated payment processors is governed by their respective security policies, all of which meet PCI DSS compliance standards.",
  },
  {
    title: "Infrastructure Security",
    content:
      "Our platform is hosted on secure cloud infrastructure with network-level isolation, intrusion detection systems, and automated DDoS protection. We maintain strict access controls to production systems with multi-factor authentication required for all administrative access. Regular security patches and updates are applied automatically.",
  },
  {
    title: "Vulnerability Management",
    content:
      "We conduct regular security assessments, including automated vulnerability scanning and manual penetration testing of our applications and infrastructure. Security findings are prioritized based on severity and remediated according to industry best practices. We also maintain a responsible disclosure program for security researchers.",
  },
  {
    title: "Data Privacy & Retention",
    content:
      "We collect only the minimum data necessary to provide our services. User data is retained only as long as necessary to fulfill the purposes described in our Privacy Policy. When data is no longer required, it is securely deleted or anonymized. We perform regular audits of data access logs to detect and prevent unauthorized access.",
  },
  {
    title: "Incident Response",
    content:
      "GRYND maintains a comprehensive incident response plan to quickly detect, respond to, and recover from security incidents. Our security team is on-call 24/7 to respond to potential threats. In the event of a data breach, affected users will be notified in accordance with applicable laws and regulations.",
  },
  {
    title: "Third-Party Security",
    content:
      "We carefully vet all third-party service providers and ensure they meet our security standards. Third-party integrations are subject to periodic security reviews. We minimize the amount of data shared with third parties and require contractual guarantees regarding data protection.",
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
            Last updated: May 24, 2026
          </p>

          <div className="mb-8 rounded-lg border border-[#00e5ff]/20 bg-[#040d24]/80 p-6 backdrop-blur-sm">
            <p className="leading-relaxed text-[#c9f7ff]">
              At GRYND, the security of your data and the integrity of our
              platform are our highest priorities. This Security Policy outlines
              the measures we take to protect your information and maintain a
              secure gaming environment.
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
            If you have any security concerns or would like to report a
            vulnerability, please contact our security team at{" "}
            <span className="text-[#f5ff3b]">contact@grynd.dedyn.io</span>.
          </p>
        </motion.div>
      </div>

      <Footer />
    </div>
  );
}
