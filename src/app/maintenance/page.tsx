import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";

export const metadata = {
  title: "Maintenance | GRYND",
  description:
    "GRYND is temporarily in maintenance. We'll be back shortly.",
  robots: { index: false, follow: false },
};

export default function MaintenancePage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center">
      <InteractiveCasinoBg variant="subtle" />

      <div className="relative z-10 mx-auto max-w-xl px-4 py-16 text-center">
        <div className="rounded-lg border border-[#00e5ff]/20 bg-[#040d24]/80 p-10 backdrop-blur-sm">
          <div className="mb-4 text-5xl">🛠️</div>
          <h1 className="mb-3 text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b]">
            We&apos;ll be right back
          </h1>
          <p className="mb-6 text-[#c9f7ff]/90">
            GRYND is temporarily in maintenance while we make improvements.
            Please check back shortly — your account, balance, and progress
            are safe.
          </p>
          <p className="text-sm text-[#c9f7ff]/60">
            If you keep seeing this page for a long time, contact us through
            our{" "}
            <a
              href="/contact"
              className="text-[#00e5ff] underline decoration-[#00e5ff]/40 underline-offset-4 hover:text-[#d8fbff]"
            >
              contact page
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
