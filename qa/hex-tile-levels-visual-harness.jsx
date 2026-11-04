// qa/hex-tile-levels-visual-harness.jsx
//
// Mounts the REAL HexTile at levels 1–4 for both seats, plus one "live" tile
// whose level can be raised from the check script so the upgrade animation can
// be watched. The stylesheet is the project's real Tailwind build, so every
// colour, weight and animation asserted by the check is the shipped one.

import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

import HexTile from "../src/components/HexTile";

const CAPACITY = { 1: 10, 2: 20, 3: 50, 4: 100 };

const tileAt = (level, owner = "player1", troops = 8) => ({
  x: 0,
  y: 0,
  owner,
  troops,
  shield: 0,
  level,
  maxTroops: CAPACITY[level],
});

function Gallery() {
  const [liveLevel, setLiveLevel] = useState(2);

  useEffect(() => {
    window.__hx = { setLevel: setLiveLevel };
  }, []);

  return (
    <div style={{ background: "#020617", minHeight: "100vh", padding: 24 }}>
      <div
        id="levels"
        style={{ display: "flex", gap: 12, flexWrap: "wrap" }}
      >
        {[1, 2, 3, 4].map((level) => (
          <HexTile
            key={level}
            tile={tileAt(level)}
            isSelected={false}
            onClick={() => {}}
            anchorKey={`p1-${level}`}
          />
        ))}
        {[2, 3, 4].map((level) => (
          <HexTile
            key={`p2-${level}`}
            tile={tileAt(level, "player2", 12)}
            isSelected={false}
            onClick={() => {}}
            anchorKey={`p2-${level}`}
          />
        ))}
      </div>

      <div id="funding" style={{ display: "flex", gap: 12, marginTop: 24 }}>
        <HexTile
          tile={tileAt(1, "player1", 4)}
          isSelected={false}
          onClick={() => {}}
          anchorKey="fund-donor"
          fundingTake={2}
        />
        <HexTile
          tile={tileAt(1, "player1", 4)}
          isSelected={false}
          onClick={() => {}}
          anchorKey="fund-target"
          fundingReceives={2}
        />
      </div>

      <div id="live" style={{ display: "flex", gap: 12, marginTop: 24 }}>
        <HexTile
          tile={tileAt(liveLevel, "player1", 12)}
          isSelected={false}
          onClick={() => {}}
          anchorKey="live"
        />
      </div>
    </div>
  );
}

window.__hxMount = () => {
  createRoot(document.getElementById("root")).render(<Gallery />);
};
