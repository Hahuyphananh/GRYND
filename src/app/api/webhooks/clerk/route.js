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
        await db
          .insert(users)
          .values({
            clerkId: id,
            email,
            password,
            name:
              username ||
              `${first_name || ""} ${last_name || ""}`.trim() ||
              "Player",
            balance: 1000,
            gamesWon: 0,
            gamesLost: 0,
          })
          .onConflictDoNothing();
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
    return new Response("Webhook Error", { status: 500 });
  }
}
