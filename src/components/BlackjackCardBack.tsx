import Image from "next/image";

export default function BlackjackCardBack() {
  return (
    <div className="h-28 w-20 rounded shadow flex items-center justify-center bg-[#030817] border-2 border-[#FFD700] relative overflow-hidden">
      {/* Subtle pattern */}
      <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_center,#FFD700_1px,transparent_1px)] bg-[length:10px_10px]" />

      {/* Logo image */}
      <Image
        src={require("../images/smalllogo.png")}
        alt="GoonBet logo"
        width={208}
        height={208}
        className="z-10 drop-shadow"
        priority
      />
    </div>
  );
}
