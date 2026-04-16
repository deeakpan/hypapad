"use client";

import { useEffect } from "react";

const CLASS = "hypapad-launch-gradient";

/** Applies the same top-down green/black gradient as /launch to `body` (use with `usesGradientHeader` in AppHeader). */
export function LaunchGradientBody() {
  useEffect(() => {
    document.body.classList.add(CLASS);
    return () => document.body.classList.remove(CLASS);
  }, []);
  return null;
}
