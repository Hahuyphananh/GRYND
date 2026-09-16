// qa/footer-social-harness.jsx
//
// Temporary harness: mounts the REAL Footer so qa/footer-social-check.mjs can
// assert the rendered social row in a real browser (Next's `next/image` and
// `next/link` are stubbed by the esbuild step — the footer uses them as plain
// <img>/<a>, and their real implementations need Next's runtime).
import { createRoot } from "react-dom/client";
import Footer from "../src/components/Footer";

createRoot(document.getElementById("root")).render(<Footer />);
