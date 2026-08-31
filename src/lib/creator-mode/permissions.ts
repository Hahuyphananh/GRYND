// src/lib/creator-mode/permissions.ts
//
// Server-side permission gate for Creator Mode.
//
// Permission model (per spec):
//   normal user        → no creator access
//   approved creator   → creator access (FUTURE — slot reserved below)
//   admin              → creator access now
//
// The single decision point is `getCreatorRole(clerkId)`. Today it only
// ever returns "admin" or "none" by reusing the existing DB-backed
// `isAdmin` check (src/lib/auth/isAdmin.ts). When the approved-creator
// program ships, the "approved-creator" branch slots in here without
// touching Creator Mode components, the API route, or any game code.

import { isAdmin } from "../auth/isAdmin";
import type { CreatorRole } from "./types";

/**
 * Resolve the creator role for a Clerk user.
 *
 * Extension point for the future creator program: an approved creator
 * will be identified here (e.g. a `creator_approved` flag on the users
 * table or a separate creators table). Until then every non-admin is
 * "none", so normal users can never reach creator mode.
 */
export async function getCreatorRole(clerkId: string): Promise<CreatorRole> {
  // Admins get creator access now (requirement: admin = creator access).
  if (await isAdmin(clerkId)) return "admin";

  // FUTURE: approved creators.
  //   if (await isApprovedCreator(clerkId)) return "approved-creator";
  // Add the DB-backed approved-creator lookup here when the program
  // launches — nothing else needs to change.

  return "none";
}

/**
 * Whether the user may use Creator Mode at all. Mirrors the role model:
 * any role other than "none" grants access, so enabling the approved-
 * creator role later automatically extends access without redesign.
 */
export async function canUseCreatorMode(clerkId: string): Promise<boolean> {
  return (await getCreatorRole(clerkId)) !== "none";
}
