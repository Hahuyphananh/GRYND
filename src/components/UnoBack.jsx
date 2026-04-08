import Image from "next/image";

export default function UnoBack() {
  return (
    <div className="w-14 h-20 rounded-lg shadow-lg flex items-center justify-center bg-[#f5ff3b] relative overflow-hidden p-2">
      {/* Logo image */}
      <Image
        src={require("../images/smalllogo.png")}
        alt="GoonBet logo"
        width={156}
        height={156}
        className="z-10 drop-shadow"
        priority
      />
    </div>
  );
}
