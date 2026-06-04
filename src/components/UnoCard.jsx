export default function UnoCard({
  color,
  value,
  onClick,
  className = "",
  style,
}) {
  // Cyberpunk neon palette — legally distinct from Mattel's red/blue/green/yellow
  const bgColors = {
    red: "#E040FB",    // neon magenta
    blue: "#00E5FF",   // neon cyan
    green: "#00E676",  // neon emerald
    yellow: "#FFD740", // neon amber
    wild: "#1A0033",   // deep void purple
  };

  const textColors = {
    red: "#fff",
    blue: "#001933",
    green: "#001a0d",
    yellow: "#1a0d00",
    wild: "#E040FB",
  };

  // Legally distinct card labels (not Mattel's "Wild", "Wild Draw Four", "Skip", "Reverse", "Draw Two")
  const symbols = {
    skip: "⦸",       // GLITCH
    reverse: "⇄",    // LOOP
    drawtwo: "+2",   // DRAIN +2
    wild: "★",       // HACK
    wilddrawfour: "+4", // SYSTEM CRASH
  };

  const cardLabels = {
    skip: "GLITCH",
    reverse: "LOOP",
    drawtwo: "DRAIN",
    wild: "HACK",
    wilddrawfour: "SYSTEM CRASH",
  };

  const normalized = value.toLowerCase().replace(/\s/g, "");
  const displaySymbol = symbols[normalized] || value;
  const cardLabel = cardLabels[normalized] || "";

  return (
    <div className="flex flex-col items-center group">
      {/* CYBERPUNK BORDER WRAPPER */}
      <div
        className="relative rounded-lg p-[2px]
        bg-gradient-to-r from-[#00e5ff] via-[#7c3aed] to-[#00e5ff]
        group-hover:shadow-[0_0_25px_rgba(0,229,255,0.6)] transition-shadow duration-300"
      >
        {/* BORDER FLOW ANIMATION */}
        <div className="absolute inset-0 pointer-events-none rounded-lg overflow-hidden">
          <div
            className="absolute h-[2px] w-full top-0
            bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowX"
          />
          <div
            className="absolute h-[2px] w-full bottom-0
            bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowX reverse"
          />
          <div
            className="absolute w-[2px] h-full left-0
            bg-gradient-to-b from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowY"
          />
          <div
            className="absolute w-[2px] h-full right-0
            bg-gradient-to-b from-transparent via-[#00e5ff] to-transparent
            animate-borderFlowY reverse"
          />
        </div>

        {/* NEON FLUSH CARD */}
        <div
          onClick={(event) => onClick?.(event)}
          className={`w-14 h-20 rounded-lg shadow-lg flex flex-col justify-center items-center cursor-pointer select-none transform hover:scale-110 hover:shadow-[0_0_20px_rgba(0,229,255,0.5)] transition-all duration-200 relative overflow-hidden ${className}`}
          style={{
            backgroundColor: bgColors[color.toLowerCase()] || "#1A0033",
            color: textColors[color.toLowerCase()] || "#E040FB",
            ...style,
          }}
        >
          {/* Scan-line overlay for cyberpunk effect */}
          <div className="absolute inset-0 bg-[linear-gradient(transparent_0%,rgba(0,229,255,0.05)_50%,transparent_100%)] pointer-events-none" />
          {/* Center symbol */}
          <span className="text-3xl font-bold drop-shadow-[0_0_8px_rgba(0,229,255,0.5)]">{displaySymbol}</span>
        </div>
      </div>

      {/* Card label */}
      <div className="mt-1 text-center text-white text-xs">
        <span className="text-[#00e5ff]">{color}</span>{" "}
        {cardLabel || value}
      </div>
    </div>
  );
}
