"use client";

import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#001a33]">
      <SignIn
        afterSignInUrl="/sync"
        appearance={{
  variables: {
    colorPrimary: "#00fff7", // neon cyan
    colorBackground: "#050b1e",
    colorText: "#00fff7",
    colorInputBackground: "#071a33",
    colorInputText: "#00fff7",
    borderRadius: "0.5rem",
    fontFamily: "Orbitron, Inter, sans-serif",
  },
  elements: {
    card:
      "backdrop-blur-xl shadow-[0_0_40px_rgba(0,255,247,0.15)] border border-[#00fff7]/20",
    headerTitle: "text-[#00fff7] tracking-widest uppercase",
    headerSubtitle: "text-[#00fff7]/60",
    socialButtonsBlockButton:
      "bg-[#071a33] border border-[#00fff7]/30 hover:shadow-[0_0_15px_#00fff7] transition-all",
    formButtonPrimary:
      "bg-[#00fff7] text-black font-bold hover:shadow-[0_0_20px_#00fff7] transition-all",
    formFieldInput:
      "bg-[#071a33] text-[#00fff7] border border-[#00fff7]/30 focus:border-[#00fff7] focus:shadow-[0_0_10px_#00fff7]",
    footerActionLink:
      "text-[#00fff7]/80 hover:text-[#00fff7] underline underline-offset-4",
  },
}}
      />
    </div>
  );
}
