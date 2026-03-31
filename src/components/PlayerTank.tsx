export default function PlayerTank({ 
  x,
  y,
  rotation,
  health,
  maxHealth,
  isEnemy = false,
  hitIntensity = 0,
  tankColor,
  playerName,
}: {
  x: number;
  y: number;
  rotation: number;
  health: number;
  maxHealth: number;
  isEnemy?: boolean;
  hitIntensity?: number;
  tankColor?: string;
  playerName?: string;
}) {
  const size = 50;
  const clampedHit = Math.max(0, Math.min(1, hitIntensity));
  const flashOpacity = clampedHit * 0.45;

  return (
    <div
      className="absolute"
      style={{
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        transform: `rotate(${rotation}deg) scale(${1 + clampedHit * 0.06})`,
        transformOrigin: "center",
        transition: "transform 90ms ease-out, filter 100ms ease-out",
        filter: clampedHit > 0 ? `drop-shadow(0 0 ${8 + clampedHit * 12}px rgba(255,120,60,0.55))` : "none",
      }}
      >
      {playerName && (
        <div
          className="absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-black/70 text-white text-[10px] font-semibold whitespace-nowrap"
          style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}
          title={playerName}
        >
          {playerName}
        </div>
      )}
      {/* Tank body */}
      <div
        className="w-full h-full rounded-md border-2 border-black relative"
        style={{ backgroundColor: tankColor ?? (isEnemy ? "#dc2626" : "#16a34a") }}
      >
        {clampedHit > 0 && (
          <div
            className="absolute inset-0 rounded-md pointer-events-none"
            style={{ background: `rgba(255, 190, 120, ${flashOpacity})` }}
          />
        )}
        {/* Barrel (shorter now) */}
        <div
          className="w-2 h-6 bg-black absolute top-0 left-1/2 -translate-x-1/2 rounded"
          style={{ transformOrigin: "bottom center" }}
        />

        {/* Health Bar (inside tank, below barrel) */}
        <div className="absolute top-[30px] left-2 right-2 h-3 bg-gray-700 rounded">
          <div
            className="h-3 bg-red-500 rounded"
            style={{ width: `${(health / maxHealth) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
