export default function PlayerTank({
  x,
  y,
  rotation,
}: {
  x: number;
  y: number;
  rotation: number;
}) {
  const size = 50;

  return (
    <div
      className="absolute"
      style={{
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        transform: `rotate(${rotation}deg)`,
        transformOrigin: "center", // <-- this fixes rotation
      }}
    >
      {/* Tank body */}
      <div className="w-full h-full bg-green-600 rounded-md border-2 border-black relative">
        {/* Barrel */}
        <div
          className="w-2 h-10 bg-black absolute top-0 left-1/2 -translate-x-1/2 rounded"
          style={{
            transformOrigin: "bottom center", // barrel rotates around its base if needed
          }}
        ></div>
      </div>
    </div>
  );
}
