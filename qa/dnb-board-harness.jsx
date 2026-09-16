// qa/dnb-board-harness.jsx
//
// Temporary harness: mounts the REAL DotsAndBoxesBoard + DotsAndBoxesLegend with
// fabricated props so qa/dnb-board-check.mjs can assert the rendered DOM in a
// real browser.
import { createRoot } from "react-dom/client";
import DotsAndBoxesBoard from "../src/components/DotsAndBoxesBoard";
import DotsAndBoxesLegend from "../src/components/DotsAndBoxesLegend";

const root = createRoot(document.getElementById("root"));

// Plain-JSON entry point: the check passes arrays, we build the Sets the board
// expects (so nothing depends on cross-context Set cloning).
window.renderBoard = (data) => {
  root.render(
    <DotsAndBoxesBoard
      {...data}
      drawnH={new Set(data.drawnH ?? [])}
      drawnV={new Set(data.drawnV ?? [])}
    />,
  );
};

// The board AND the legend mounted as siblings — exactly how the page stacks
// them (board, then the color key directly beneath). Mounting them together is
// what lets the check compare the legend's swatches against the colors the
// board actually painted, rather than against hard-coded constants.
window.renderBoardWithLegend = ({ board, legend }) => {
  root.render(
    <div>
      <DotsAndBoxesBoard
        {...board}
        drawnH={new Set(board.drawnH ?? [])}
        drawnV={new Set(board.drawnV ?? [])}
      />
      <DotsAndBoxesLegend {...legend} />
    </div>,
  );
};
