"use client";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import { motion } from "framer-motion";
import Link from "next/link";

const sections = [
  {
    title: "Our Commitment",
    content: [
      "GRYND is committed to providing an inclusive and accessible experience for all users, including those with disabilities. We design and build our platform with the Web Content Accessibility Guidelines (WCAG) 2.1 Level AA in mind, and we continuously work to improve accessibility through user feedback and design iterations. Accessibility is an ongoing effort — we are honest that not every page and game is fully conformant today, and we treat reported barriers as priority issues.",
    ],
  },
  {
    title: "Keyboard Navigation",
    content: [
      "All interactive elements on GRYND are operable via keyboard alone. You can navigate using Tab and Shift+Tab to move between focusable elements, Enter or Space to activate buttons and links, Escape to close modals and overlays, and arrow keys to navigate within game interfaces. A \"Skip to main content\" link is available on every page for quick access to primary content.",
    ],
  },
  {
    title: "Screen Reader Support",
    content: [
      "We use semantic HTML, ARIA landmarks, and descriptive labels throughout the platform to support compatibility with popular screen readers including NVDA, JAWS, and VoiceOver. Images include alt text, form inputs have associated labels, and dynamic content changes are announced via live regions where appropriate.",
    ],
  },
  {
    title: "Color & Contrast",
    content: [
      "Our dark theme is designed with sufficient color contrast between text and backgrounds, and interactive elements have visible focus indicators. We never rely solely on color to convey information — additional visual cues such as icons, patterns, and text labels are used throughout.",
    ],
  },
  {
    title: "Focus Indicators",
    content: [
      "All interactive elements on GRYND feature clearly visible focus indicators. When navigating by keyboard, you will always see which element is currently focused. Focus order follows a logical sequence matching the visual layout of each page.",
    ],
  },
  {
    title: "Text Sizing & Zoom",
    content: [
      "Our platform supports browser zoom up to 200% without loss of content or functionality. Text scales using relative units where practical, and layouts reflow to accommodate larger text sizes. You can adjust your browser's default font size and zoom level without breaking the interface.",
    ],
  },
  {
    title: "Reduced Motion",
    content: [
      "We respect your system-level motion preferences. If you have enabled \"Reduce motion\" in your operating system or browser settings, GRYND automatically disables non-essential animations, transitions, and parallax effects. Critical feedback related to gameplay remains functional but is shortened and simplified.",
    ],
  },
  {
    title: "Real-Time & Skill Games",
    content: [
      "Some of our games are real-time and require fast reactions or rapid input (for example, Precision timing challenges). These games may be difficult or impossible for users with certain motor or cognitive disabilities. Where a game offers one, the free practice (fun/AI) mode can be used without wagering, and no penalty applies for choosing not to play a game that does not suit your abilities. We are working to increase accessibility options across our games.",
    ],
  },
  {
    title: "Feedback & Contact",
    content: [
      "We welcome feedback on accessibility. If you encounter any barriers while using GRYND, or have suggestions for improvement, please contact us through our contact page. We aim to respond to accessibility inquiries within 5 business days and will work with you to find a solution or an alternative format.",
    ],
  },
];

export default function AccessibilityPage() {
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
            Accessibility Policy
          </h1>
          <p className="mb-8 text-lg text-[#9dd8ff]">
            Last updated: September 4, 2026
          </p>

          <div className="mb-8 rounded-lg border border-[#00e5ff]/20 bg-[#040d24]/80 p-6 backdrop-blur-sm">
            <p className="leading-relaxed text-[#c9f7ff]">
              Accessibility is a core design principle at GRYND. We believe
              everyone should be able to enjoy skill-based gaming, regardless
              of ability. This policy outlines the measures we have taken and
              the standards we work toward to ensure our platform is usable by
              the widest possible audience.
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
            For accessibility inquiries,{" "}
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
