import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { drizzle } from 'drizzle-orm/node-postgres';
import { users } from "../../../../db/schema"; // adjust the import if needed
import { auditLog } from "../../../../lib/security/auditLog";

let dbInstance = null;

function getDb() {
  if (dbInstance) return dbInstance;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not defined in the environment variables");
  }

  dbInstance = drizzle(connectionString);
  return dbInstance;
}

export async function POST(req) {
  try {
    const body = await req.json();
    const svixId = req.headers.get("svix-id");
    const svixTimestamp = req.headers.get("svix-timestamp");
    const svixSignature = req.headers.get("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      return new Response("Missing Svix headers", { status: 400 });
    }

    if (!process.env.CLERK_WEBHOOK_SECRET) {
      throw new Error("CLERK_WEBHOOK_SECRET is not defined in the environment variables");
    }
    const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET);
    const payload = body;
    const evt = wh.verify(JSON.stringify(payload), {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });

    const eventType = evt.type;

    if (eventType === "user.created") {
      const { id, email_addresses, first_name, last_name } = evt.data;

      await getDb().insert(users).values({
        clerkId: id,
        email: email_addresses[0]?.email_address || "",
        name: `${first_name || ""} ${last_name || ""}`.trim(),
        balance: 1000, // Default starting tokens
        gamesWon: 0,
        gamesLost: 0,
      });

      auditLog("webhook_user_created", { clerkId: id });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("❌ Error processing webhook:", err);
    return new Response("Webhook Error", { status: 500 });
  }
}
