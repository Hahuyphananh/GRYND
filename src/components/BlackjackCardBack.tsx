import Image from "next/image";
import smallLogo from "../images/smalllogo.png";

export default function BlackjackCardBack() {
  return (
    <div
      className="h-28 w-20 relative rounded-lg overflow-hidden
      bg-gradient-to-br from-[#000814] via-[#001933] to-[#000814]
      shadow-[0_0_25px_rgba(0,229,255,0.6),0_0_60px_rgba(0,229,255,0.25)]"
    >
      {/*  Static border */}
      <div className="absolute inset-0 rounded-lg p-[2px] bg-gradient-to-r from-[#00e5ff] via-[#7c3aed] to-[#00e5ff]">
        {/*  Edge-flow animation */}
        <div className="absolute inset-0 pointer-events-none rounded-lg overflow-hidden">
          <div className="absolute h-[3px] w-full top-0 bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent animate-borderFlowX"></div>
          <div className="absolute h-[3px] w-full bottom-0 bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent animate-borderFlowX reverse"></div>
          <div className="absolute w-[3px] h-full left-0 bg-gradient-to-b from-transparent via-[#00e5ff] to-transparent animate-borderFlowY"></div>
          <div className="absolute w-[3px] h-full right-0 bg-gradient-to-b from-transparent via-[#00e5ff] to-transparent animate-borderFlowY reverse"></div>
        </div>

        {/*  Inner card */}
        <div
          className="h-full w-full rounded-lg
          bg-gradient-to-br from-[#000814] via-[#00111f] to-[#000814]
          flex items-center justify-center relative overflow-hidden"
        >
          {/*  Cyber grid */}
          <div
            className="absolute inset-0 opacity-25
            bg-[linear-gradient(#00e5ff22_1px,transparent_1px),linear-gradient(90deg,#00e5ff22_1px,transparent_1px)]
            bg-[size:12px_12px]"
          />

          {/*  Inner glow */}
          <div className="absolute inset-0 bg-[#00e5ff]/20 blur-2xl opacity-70" />

          {/*  Logo */}
          <Image
            src={smallLogo}
            alt="GoonBet logo"
            width={120}
            height={120}
            className="z-10 drop-shadow-[0_0_18px_rgba(0,229,255,1)]"
            priority
          />
        </div>
      </div>
    </div>
  );
}
