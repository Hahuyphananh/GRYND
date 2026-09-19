// qa/access-denied-harness.jsx
//
// Temporary harness: mounts the REAL /access-denied page
// (src/app/access-denied/PageClient.jsx) with the usual dependency stubs, so
// qa/access-denied-check.mjs can verify the rebrand and the two Actions in a
// real browser. The REAL <SignOutButton> is kept (only Clerk is stubbed) so the
// check exercises the actual sign-out wiring; the stub records signOut calls.
import React from "react";
import { createRoot } from "react-dom/client";
import AccessDeniedPage from "../src/app/access-denied/PageClient";

const root = createRoot(document.getElementById("root"));
window.__signOuts = [];

// Keyed so each render is a genuinely fresh mount.
let mountCount = 0;
window.renderAccessDenied = () => {
  mountCount += 1;
  root.render(<AccessDeniedPage key={mountCount} />);
};
