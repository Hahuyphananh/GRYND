// standalone/solitaire-duel/src/main.tsx
//
// The whole application, mounted once. There is no router, no provider stack
// and no global state: the game is a single screen with a local match object.

import { createRoot } from "react-dom/client";

import App from "./App";
import "./theme.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Standalone mount point #root is missing");
}

createRoot(container).render(<App />);
