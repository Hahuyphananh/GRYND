// qa/ta-block-art-harness.jsx
//
// Mounts the REAL TowerScene (exported from the match page) and the REAL
// BlockGlyph (the picker's icon, from src/components/tower-arena/BlockArt) so
// qa/ta-block-art-check.mjs can measure the block art in a real browser at
// several widths. The page's non-visual dependencies are stubbed by the esbuild
// step, exactly like qa/ta-trail-check.mjs.
import { createRoot } from "react-dom/client";
import { TowerScene } from "../src/app/casino/tower-arena/game/[matchId]/PageClient";
import {
  BLOCK_PALETTE,
  BlockGlyph,
} from "../src/components/tower-arena/BlockArt";

const SHAPES = ["I", "L", "T", "square", "short", "long", "big"];

// One block of every shape, so the scene paints all seven palette entries.
const TOWER = [
  { id: "square", shape: "square", turnNumber: 1, cells: [{ x: 3, z: 0 }, { x: 4, z: 0 }] },
  { id: "I", shape: "I", turnNumber: 2, cells: [{ x: 2, z: 1 }, { x: 3, z: 1 }, { x: 4, z: 1 }] },
  { id: "long", shape: "long", turnNumber: 3, cells: [{ x: 2, z: 2 }, { x: 3, z: 2 }, { x: 4, z: 2 }, { x: 5, z: 2 }] },
  { id: "short", shape: "short", turnNumber: 4, cells: [{ x: 4, z: 3 }] },
  { id: "L", shape: "L", turnNumber: 5, cells: [{ x: 5, z: 3 }, { x: 5, z: 4 }] },
  { id: "T", shape: "T", turnNumber: 6, cells: [{ x: 2, z: 5 }, { x: 3, z: 5 }, { x: 2, z: 6 }, { x: 3, z: 6 }] },
  { id: "big", shape: "big", turnNumber: 7, cells: [
    { x: 2, z: 7 }, { x: 3, z: 7 }, { x: 4, z: 7 },
    { x: 2, z: 8 }, { x: 3, z: 8 }, { x: 4, z: 8 },
  ] },
];

window.__palette = BLOCK_PALETTE;
window.__shapes = SHAPES;
window.__stageClicks = 0;

const root = createRoot(document.getElementById("root"));

function Picker() {
  return (
    <div id="picker" style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: 12, background: "#040d24" }}>
      {SHAPES.map((shape) => (
        <div key={shape} data-glyph={shape} style={{ display: "flex", gap: 6 }}>
          {["available", "selected", "unavailable"].map((state) => (
            <span key={state} data-glyph-state={`${shape}:${state}`} style={{ display: "inline-flex" }}>
              <BlockGlyph shape={shape} size={26} state={state} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

window.renderArt = ({ width = 390, height = 380, withPicker = true, withStageClick = true } = {}) => {
  root.render(
    <div>
      <div id="stage" style={{ width, height, background: "#05070f" }}>
        <TowerScene
          tower={TOWER}
          ghost={null}
          falling={null}
          cursor={null}
          impact={0}
          remoteAiming={null}
          onStageClick={withStageClick ? () => { window.__stageClicks += 1; } : undefined}
        />
      </div>
      {withPicker && <Picker />}
    </div>,
  );
};

window.__ready = true;
