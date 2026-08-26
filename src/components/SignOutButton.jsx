"use client";

import React from "react";
import { useClerk } from "@clerk/nextjs";
import { clearSessionArtifacts } from "../lib/security/sessionCleanup";

/**
 * Canonical sign-out button. Sweeps app-owned session artifacts (admin_mfa
 * cookie, per-user admin/nav caches, game-session tokens) BEFORE revoking
 * the Clerk session, then signs out and redirects to "/". Falls back to a
 * hard redirect if the revocation throws (e.g. the Clerk user was already
 * deleted server-side).
 *
 * Accepts optional children so callers can pass their own styled element
 * (the onClick is injected onto it); without children it renders a plain
 * button.
 */
export const SignOutButton = ({ children, className }) => {
  const { signOut } = useClerk();

  const handleSignOut = async () => {
    // Clear device artifacts first so a failed/raced signOut still leaves
    // the machine clean. The server-cookie clear is fire-and-forget with
    // keepalive, so it survives the redirect below.
    clearSessionArtifacts();
    try {
      await signOut({ redirectUrl: "/" });
    } catch (err) {
      console.warn("[SIGNOUT]", err);
      window.location.href = "/";
    }
  };

  if (children) {
    return React.cloneElement(children, { onClick: handleSignOut });
  }

  return (
    <button type="button" onClick={handleSignOut} className={className}>
      Sign out
    </button>
  );
};
