"use client";

import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#001a33]">
      <SignUp
        fallbackRedirectUrl="/sync"
        appearance={{
          variables: {
            colorPrimary: "#00fff7",
            colorBackground: "#050b1e",

            // ✅ FIX: main text should be bright white, not neon
            colorForeground: "#f5f9ff",

            // inputs
            colorInput: "#071a33",

            // ❗ FIX: input text was neon cyan (bad contrast on dark UI)
            colorInputForeground: "#f5f9ff",

            borderRadius: "0.5rem",
            fontFamily: "Orbitron, Inter, sans-serif",
          },
          elements: {
            card: "backdrop-blur-xl shadow-[0_0_40px_rgba(0,255,247,0.15)] border border-[#00fff7]/20",

            headerTitle: "text-[#00fff7] tracking-widest uppercase font-bold",

            // ✅ FIX: make subtitle readable
            headerSubtitle: "text-white/80",

            socialButtonsBlockButton:
              "bg-[#071a33] text-white border border-[#00fff7]/30 hover:shadow-[0_0_15px_#00fff7] transition-all",

            formButtonPrimary:
              "bg-[#00fff7] text-black font-bold hover:shadow-[0_0_20px_#00fff7] transition-all",

            formFieldLabel: "text-white/80", // 👈 IMPORTANT FIX

            formFieldInput:
              "bg-[#071a33] text-white border border-[#00fff7]/30 focus:border-[#00fff7] focus:shadow-[0_0_10px_#00fff7]",

            footerActionLink:
              "text-white/70 hover:text-[#00fff7] underline underline-offset-4",
          },
        }}
      />
    </div>
  );
}
