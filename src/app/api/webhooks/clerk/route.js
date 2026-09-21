import { NextResponse } from "next/server";
import { Webhook } from "svix";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { users, userAutomationState } from "../../../../db/schema";
import { auditLog } from "../../../../lib/security/auditLog";
import { deleteUserLocalData } from "../../../../lib/security/deleteUserData";
import { sendWelcomeEmail } from "../../../../lib/emails/welcome";
// Use the shared app pool (single connection pool + SSL handling) instead
// of spinning up a second raw drizzle client from DATABASE_URL, which
// would bypass the shared pool's SSL config and connection limits.
import { db } from "../../../../db";
import { logError } from "../../../../lib/logError";
import { grantAllOfficialIcons } from "../../../../lib/icons";
import { reconcileEmoteState } from "../../../../lib/emotes";
import { searchNameFor } from "../../../../lib/searchName";

export async function POST(req) {
  try {
    const body = await req.json();
    const svixId = req.headers.get("svix-id");
    const svixTimestamp = req.headers.get("svix-timestamp");
    const svixSignature = req.headers.get("svix-signature");
    if (!svixId || !svixTimestamp || !svixSignature)
      return new Response("Missing Svix headers", { status: 400 });

    const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET);
    const evt = wh.verify(JSON.stringify(body), {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });

    if (evt.type === "user.created") {
      const { id, email_addresses, username, first_name, last_name } = evt.data;
      const email = email_addresses?.[0]?.email_address;
      if (email) {
        // users.password is NOT NULL with no DB default — without a value
        // here the insert throws, which breaks the welcome email + automation
        // state below. Clerk owns authentication, so a random hash is fine.
        const password = await bcrypt.hash(
          crypto.randomBytes(32).toString("hex"),
          12,
        );
        const displayName =
          username ||
          `${first_name || ""} ${last_name || ""}`.trim() ||
          "Player";
        const insertedRows = await db
          .insert(users)
          .values({
            clerkId: id,
            email,
            password,
            name: displayName,
            // Folded match key for /api/friends/search, derived from the same
            // display name so the two always agree (src/lib/searchName.ts).
            searchName: searchNameFor(displayName),
            balance: 1000,
            gamesWon: 0,
            gamesLost: 0,
          })
          .onConflictDoNothing()
          .returning({ id: users.id });
        // A brand-new local user owns the full free official icon catalog
        // (default + all 12). Guarantees every account can access every icon
        // in the picker regardless of whether it ever hits the sync-user
        // fresh-account path. Idempotent + best-effort.
        if (insertedRows?.length) {
          const newUserId = insertedRows[0].id;
          await grantAllOfficialIcons(newUserId).catch((err) =>
            console.warn("[clerk-webhook] icon grant failed:", err),
          );
          // New accounts also auto-own the 8 FREE animated emotes and get the
          // default loadout seeded (reconcileEmoteState seeds only on the
          // very first free grant — idempotent + safe to run repeatedly).
          await reconcileEmoteState(newUserId).catch((err) =>
            console.warn("[clerk-webhook] emote grant failed:", err),
          );
        }
        await db
          .insert(userAutomationState)
          .values({
            clerkId: id,
            lastLoginAt: new Date(),
            inactivityCycleStartAt: new Date(),
          })
          .onConflictDoNothing();
        await sendWelcomeEmail({
          clerkId: id,
          email,
          username: username || first_name || "Player",
        });
      }
      auditLog("webhook_user_created", { clerkId: id });
    }

    if (evt.type === "session.created") {
      const clerkId = evt.data.user_id;
      await db
        .insert(userAutomationState)
        .values({
          clerkId,
          lastLoginAt: new Date(),
          inactivityCycleStartAt: new Date(),
          lastInactivityEmailSentAt: null,
        })
        .onConflictDoUpdate({
          target: userAutomationState.clerkId,
          set: {
            lastLoginAt: new Date(),
            inactivityCycleStartAt: new Date(),
            lastInactivityEmailSentAt: null,
            updatedAt: new Date(),
          },
        });
      auditLog("webhook_session_created", { clerkId });
    }

    if (evt.type === "user.deleted") {
      // Account removed on Clerk's side (admin action, or the user
      // deleting via Clerk's own portal). Clean up the local rows so no
      // orphaned personal data survives. This is the same purge the
      // in-app delete-account route performs (shared helper).
      const clerkId = evt.data.id;
      if (clerkId) {
        const removed = await deleteUserLocalData(clerkId);
        auditLog("webhook_user_deleted", { clerkId, removed });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Webhook Error", err);
    await logError({
      errorType: "clerk_webhook_error",
      errorMessage: err instanceof Error ? err.message : "Clerk webhook failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/webhooks/clerk",
      metadata: { operation: "clerk_webhook" },
    });
    return new Response("Webhook Error", { status: 500 });
  }
}
