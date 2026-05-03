import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { users, userAutomationState } from "../../../../db/schema";
import { auditLog } from "../../../../lib/security/auditLog";
import { sendWelcomeEmail } from "../../../../lib/emails/welcome";

let dbInstance = null;
const getDb = () => (dbInstance ??= drizzle(process.env.DATABASE_URL));

export async function POST(req) {
  try {
    const body = await req.json();
    const svixId = req.headers.get("svix-id");
    const svixTimestamp = req.headers.get("svix-timestamp");
    const svixSignature = req.headers.get("svix-signature");
    if (!svixId || !svixTimestamp || !svixSignature) return new Response("Missing Svix headers", { status: 400 });

    const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET);
    const evt = wh.verify(JSON.stringify(body), { "svix-id": svixId, "svix-timestamp": svixTimestamp, "svix-signature": svixSignature });

    if (evt.type === "user.created") {
      const { id, email_addresses, username, first_name, last_name } = evt.data;
      const email = email_addresses?.[0]?.email_address;
      if (email) {
        await getDb().insert(users).values({ clerkId: id, email, name: username || `${first_name || ""} ${last_name || ""}`.trim() || "Player", balance: 1000, gamesWon: 0, gamesLost: 0 }).onConflictDoNothing();
        await getDb().insert(userAutomationState).values({ clerkId: id, lastLoginAt: new Date(), inactivityCycleStartAt: new Date() }).onConflictDoNothing();
        await sendWelcomeEmail({ clerkId: id, email, username: username || first_name || "Player" });
      }
      auditLog("webhook_user_created", { clerkId: id });
    }

    if (evt.type === "session.created") {
      const clerkId = evt.data.user_id;
      await getDb().insert(userAutomationState).values({ clerkId, lastLoginAt: new Date(), inactivityCycleStartAt: new Date(), lastInactivityEmailSentAt: null }).onConflictDoUpdate({ target: userAutomationState.clerkId, set: { lastLoginAt: new Date(), inactivityCycleStartAt: new Date(), lastInactivityEmailSentAt: null, updatedAt: new Date() } });
      auditLog("webhook_session_created", { clerkId });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Webhook Error", err);
    return new Response("Webhook Error", { status: 500 });
  }
}
