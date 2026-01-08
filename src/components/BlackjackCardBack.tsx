export default function BlackjackCardBack() {
  return (
    <div className="h-28 w-20 rounded shadow flex flex-col items-center justify-center bg-[#003366] border-2 border-[#FFD700] relative overflow-hidden">
      {/* Subtle pattern */}
      <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_center,#FFD700_1px,transparent_1px)] bg-[length:10px_10px]" />

      {/* Logo */}
      <span className="text-[#FFD700] text-lg font-extrabold leading-none drop-shadow mb-3">
        Moon
      </span>
      <span className="text-[#FFD700] text-lg font-extrabold leading-none drop-shadow -mt-1">
        Bet
      </span>

      {/* Optional icon */}
      <span className="text-base mt-2">🎲</span>
    </div>
  );
}
