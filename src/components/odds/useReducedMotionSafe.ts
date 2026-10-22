"use client";

// src/components/odds/useReducedMotionSafe.ts
//
// framer-motion's `useReducedMotion` returns null on the server and for the
// first client paint (it reads the media query in an effect). For the odds
// reveal that gap matters: a reduced-motion player would see one frame of the
// marker at 12 o'clock before it jumps to the target. This hook falls back to
// a synchronous media-query read during the first render, so the very first
// frame is already the settled one.

import { useState } from "react";
import { useReducedMotion } from "framer-motion";

function mediaPrefersReduced(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function useReducedMotionSafe(): boolean {
  const fromFramer = useReducedMotion();
  const [fromMedia] = useState(mediaPrefersReduced);
  return fromFramer ?? fromMedia;
}

export default useReducedMotionSafe;
