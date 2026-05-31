"use client";

import React from "react";

/**
 * Reusable admin badge pill used in the navigation bar, admin dashboard,
 * and user management tables.
 */
export default function AdminBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/40 px-1.5 py-0.5 text-[9px] font-bold text-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.3)] ${className}`}
    >
      ADMIN
    </span>
  );
}
