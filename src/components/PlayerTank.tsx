export default function PlayerTank({
  x,
  y,
  rotation,
  health,
  maxHealth,
  variant = "player",
}: {
  x: number;
  y: number;
  rotation: number;
  health: number;
  maxHealth: number;
  variant?: "player" | "enemy";
}) {
  const size = 50;
  const bodyClass =
    variant === "enemy"
      ? "bg-red-600 border-red-900"
      : "bg-green-600 border-green-900";

  return (
    <div
      className="absolute"
      style={{
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        transform: `rotate(${rotation}deg)`,
        transformOrigin: "center",
      }}
    >
      <div
        className={`w-full h-full rounded-md border-2 border-black relative ${bodyClass}`}
      >
        <div
          className="w-2 h-6 bg-black absolute top-0 left-1/2 -translate-x-1/2 rounded"
          style={{ transformOrigin: "bottom center" }}
        />

        <div className="absolute top-[30px] left-2 right-2 h-3 bg-gray-700 rounded">
          <div
            className="h-3 bg-red-500 rounded"
            style={{ width: `${Math.max(0, (health / maxHealth) * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
