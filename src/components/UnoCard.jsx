export default function UnoCard({ color, value, onClick, className = "", style }) {
  const bgColors = {
    red: "#D32F2F",
    blue: "#1976D2",
    green: "#388E3C",
    yellow: "#FBC02D",
    wild: "#000000",
  };

  const symbols = {
    skip: "⦸",
    reverse: "⇄",
    drawtwo: "+2",
    wild: "★",
    wilddrawfour: "+4",
  };

  const normalized = value.toLowerCase().replace(/\s/g, "");
  const displaySymbol = symbols[normalized] || value;

  return (
    <div className="flex flex-col items-center">
      
      {/* 🔵 CYBERPUNK BORDER WRAPPER */}
      <div className="relative rounded-lg p-[2px]
        bg-gradient-to-r from-[#00e5ff] via-[#7c3aed] to-[#00e5ff]">

        {/* ⚡ BORDER-ONLY ANIMATION */}
        <div className="absolute inset-0 pointer-events-none rounded-lg overflow-hidden">
          {/* Top */}
          <div className="absolute h-[2px] w-full top-0
            bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowX" />

          {/* Bottom */}
          <div className="absolute h-[2px] w-full bottom-0
            bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowX reverse" />

          {/* Left */}
          <div className="absolute w-[2px] h-full left-0
            bg-gradient-to-b from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowY" />

          {/* Right */}
          <div className="absolute w-[2px] h-full right-0
            bg-gradient-to-b from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowY reverse" />
        </div>

        {/* 🟥 ACTUAL UNO CARD (UNCHANGED) */}
        <div
          onClick={(event) => onClick?.(event)}
          className={`w-14 h-20 rounded-lg shadow-lg flex flex-col justify-center items-center cursor-pointer select-none transform hover:scale-105 transition-transform relative overflow-hidden ${className}`}
          style={{
            backgroundColor: bgColors[color.toLowerCase()] || "#000",
            color: color.toLowerCase() === "yellow" ? "#000" : "#fff",
            ...style,
          }}
        >
          {/* Center symbol */}
          <span className="text-3xl font-bold">{displaySymbol}</span>
        </div>
      </div>

      {/* Card label */}
      <div className="mt-1 text-center text-white text-xs">
        {color} {value}
      </div>
    </div>
  );
}