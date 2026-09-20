// qa/fiar-trail-harness.jsx
//
// Mounts the REAL Four-In-A-Row vs-AI page (its presentation-only imports are
// stubbed by qa/fiar-trail-check.mjs) so the falling disc + Towers-style trail
// can be measured frame by frame in Chromium, exactly like qa/ta-trail-check.mjs
// does for Tower Arena.
import { createRoot } from "react-dom/client";
import ConnectFourAiPage from "../src/app/casino/four-in-a-row/play-ai/PageClient";

let root = null;

window.mountPage = () => {
  if (root) root.unmount();
  root = createRoot(document.getElementById("root"));
  root.render(<ConnectFourAiPage />);
};

window.unmountPage = () => {
  if (root) {
    root.unmount();
    root = null;
  }
};
