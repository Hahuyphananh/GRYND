export default function UnoCard({ color, value, onClick }) {
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

  // Normalize value for symbol lookup
  const normalized = value.toLowerCase().replace(/\s/g, "");
  const displaySymbol = symbols[normalized] || value;

  return (
    <div className="flex flex-col items-center">
      <div
        onClick={onClick}
        className="w-14 h-20 rounded-lg shadow-lg flex flex-col justify-center items-center cursor-pointer select-none transform hover:scale-105 transition-transform relative overflow-hidden"
        style={{
          backgroundColor: bgColors[color.toLowerCase()] || "#000",
          color: color.toLowerCase() === "yellow" ? "#000" : "#fff",
        }}
      >
        {/* Centered symbol */}
        <span className="text-3xl font-bold">{displaySymbol}</span>
      </div>

      {/* Card name and color */}
      <div className="mt-1 text-center text-white text-xs">
        {color} {value}
      </div>
    </div>
  );
}
