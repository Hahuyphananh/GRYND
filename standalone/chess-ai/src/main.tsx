// standalone/chess-ai/src/main.tsx
//
// The standalone chess app, mounted once. One screen, one local match, no
// router, no provider stack, no server.

import { createRoot } from "react-dom/client";

import App from "./App";
import "./theme.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Standalone mount point #root is missing");
}

createRoot(container).render(<App />);
