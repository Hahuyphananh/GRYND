"use client";

import Image from "next/image";
import smallLogo from "../images/smalllogo.png";

export default function UnoBack() {
  return (
    <div
      className="w-14 h-20 relative rounded-lg overflow-hidden
      bg-gradient-to-br from-[#000814] via-[#001933] to-[#000814]
      shadow-[0_0_20px_rgba(0,229,255,0.6),0_0_40px_rgba(0,229,255,0.25)]"
    >
      {/*  SAME BORDER as Blackjack */}
      <div
        className="absolute inset-0 rounded-lg p-[2px]
        bg-gradient-to-r from-[#00e5ff] via-[#7c3aed] to-[#00e5ff]"
      >
        {/*  SAME EDGE FLOW ANIMATION */}
        <div className="absolute inset-0 pointer-events-none rounded-lg overflow-hidden">
          {/* Top */}
          <div
            className="absolute h-[2px] w-full top-0
            bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowX"
          />

          {/* Bottom */}
          <div
            className="absolute h-[2px] w-full bottom-0
            bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowX reverse"
          />

          {/* Left */}
          <div
            className="absolute w-[2px] h-full left-0
            bg-gradient-to-b from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowY"
          />

          {/* Right */}
          <div
            className="absolute w-[2px] h-full right-0
            bg-gradient-to-b from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowY reverse"
          />
        </div>

        {/*  INNER CARD */}
        <div
          className="h-full w-full rounded-lg
          bg-gradient-to-br from-[#000814] via-[#00111f] to-[#000814]
          flex items-center justify-center relative overflow-hidden"
        >
          {/*  Cyber grid (same as blackjack) */}
          <div
            className="absolute inset-0 opacity-25
            bg-[linear-gradient(#00e5ff22_1px,transparent_1px),linear-gradient(90deg,#00e5ff22_1px,transparent_1px)]
            bg-[size:10px_10px]"
          />

          {/*  Inner glow */}
          <div className="absolute inset-0 bg-[#00e5ff]/20 blur-xl opacity-70" />

          {/*  Logo */}
          <Image
            src={smallLogo}
            alt="GRYND logo"
            width={90}
            height={90}
            className="z-10 drop-shadow-[0_0_12px_rgba(0,229,255,1)]"
            priority
          />
        </div>
      </div>
    </div>
  );
}
