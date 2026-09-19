// qa/complete-profile-harness.jsx
//
// Temporary harness: mounts the REAL /complete-profile page
// (src/app/complete-profile/PageClient.jsx) with the same dependency stubs the
// other QA checks use, so qa/complete-profile-check.mjs can drive the age gate
// in a real browser.
//
// `fetch` is replaced with a recorder (the page would otherwise POST to a real
// endpoint) and `next/navigation`'s router records `push`, so the check can
// assert the request body and the post-verify redirect without a server.
import React from "react";
import { createRoot } from "react-dom/client";
import CompleteProfilePage from "../src/app/complete-profile/PageClient";

const root = createRoot(document.getElementById("root"));

window.__fetches = [];
window.__pushes = [];

// Deterministic fetch stub: the page only cares about `result.success`.
window.fetch = (url, options = {}) => {
  window.__fetches.push({ url: String(url), body: options.body ?? null });
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true }),
  });
};

// Keyed on every render so the check gets a genuinely FRESH page mount (a
// re-render of the same element keeps the previous form state — e.g. the
// "Verifying…" a successful submit leaves behind).
let mountCount = 0;
window.renderProfile = () => {
  mountCount += 1;
  root.render(<CompleteProfilePage key={mountCount} />);
};
window.__mountCount = () => mountCount;
