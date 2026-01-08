export default function UnoBack() {
  return (
    <div className="w-14 h-20 rounded-lg shadow-lg flex flex-col items-center justify-center bg-blue-600 relative overflow-hidden p-2">
      {/* MoonBet split over two lines */}
      <span className="text-yellow-400 text-lg font-extrabold drop-shadow-md">
        Moon
      </span>
      <span className="text-yellow-400 text-lg font-extrabold drop-shadow-md -mt-1">
        Bet
      </span>
      {/* Optional brand symbol */}
      <span className="text-xs mt-1">🎲</span>
    </div>
  );
}
