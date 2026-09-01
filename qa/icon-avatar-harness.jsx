// qa/icon-avatar-harness.jsx
// Mounts the real IconAvatar component on #root. Keeps the SAME mounted
// instance across prop changes (like the profile page + nav bar do when the
// user equips a different icon), so we can reproduce the stuck-fallback bug.
import React from "react";
import { createRoot } from "react-dom/client";
import IconAvatar from "../src/components/IconAvatar";

const rootEl = document.getElementById("root");
const root = createRoot(rootEl);

window.renderIcon = (props) => {
  root.render(React.createElement(IconAvatar, props));
};