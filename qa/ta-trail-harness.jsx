// qa/ta-trail-harness.jsx
//
// Temporary harness: mounts the REAL TowerScene (exported from the match page)
// with fabricated props so qa/ta-trail-check.mjs can measure the actual fall +
// trail animation in a real browser. The page's non-visual dependencies
// (Clerk/socket/analytics/creator-mode) are stubbed by the esbuild step — the
// scene itself only needs framer-motion and the engine's shapes.
import { createRoot } from "react-dom/client";
import { TowerScene } from "../src/app/casino/tower-arena/game/[matchId]/PageClient";

const root = createRoot(document.getElementById("root"));

// Each renderScene() call is a fresh DROP, so it must be a fresh mount: the
// scene's hooks (e.g. framer-motion's useReducedMotion) read the environment
// once per mount, and reusing an instance would both freeze that reading and
// leave the previous drop's animation running.
let dropSeq = 0;
let current = {};
// Landing relay: what the real page does with the scene's landing signal is
// bump the impact token, so the harness can do exactly that (`relayImpact`) and
// qa/ta-rumble-check.mjs can time the thud against the block's own landing.
let landings = [];
window.__landings = landings;

function render() {
  const { width = 420, height = 620, ...scene } = current;
  root.render(
    <div style={{ width, height }}>
      <TowerScene
        key={`drop-${dropSeq}`}
        tower={scene.tower ?? []}
        ghost={scene.ghost ?? null}
        falling={scene.falling ?? null}
        cursor={scene.cursor ?? null}
        impact={scene.impact ?? 0}
        remoteAiming={scene.remoteAiming ?? null}
        onDropLanded={(key) => {
          landings.push({ key, t: performance.now() });
          if (!current.relayImpact) return;
          current = { ...current, impact: (current.impact ?? 0) + 1 };
          render();
        }}
      />
    </div>,
  );
}

// Plain-JSON entry points so the checks can drive scenarios (human drop, bot
// drop, cleared drop), vary the container size to prove the trail is
// resolution-independent, and — for the rumble — change props IN PLACE
// (`updateScene`), which is how the real page delivers a new impact token.
window.renderScene = (props = {}) => {
  current = { ...current, ...props };
  dropSeq += 1;
  landings = [];
  window.__landings = landings;
  window.__dropAt = current.falling ? performance.now() : null;
  render();
};

window.updateScene = (props = {}) => {
  current = { ...current, ...props };
  render();
};
