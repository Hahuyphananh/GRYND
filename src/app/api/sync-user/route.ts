import bcrypt from "bcrypt";
import crypto from "crypto";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { logError } from "../../../lib/logError";
import { grantAllOfficialIcons } from "../../../lib/icons";

export async function POST(req: Request) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json(
        { error: "Unauthorized - No session" },
        { status: 401 },
      );
    }

    const client = await clerkClient();
    let clerkUser = null;

    for (let i = 0; i < 3; i++) {
      try {
        clerkUser = await client.users.getUser(clerkId);
        if (clerkUser) break;
      } catch {
        console.warn("Retrying Clerk user fetch...", i + 1);
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    if (!clerkUser) {
      return NextResponse.json(
        { error: "Clerk user not ready yet" },
        { status: 400 },
      );
    }

    const primaryEmail = clerkUser.emailAddresses?.find(
      (email) => email.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress;
    const email = primaryEmail || clerkUser.emailAddresses?.[0]?.emailAddress;

    if (!email) {
      return NextResponse.json(
        { error: "Clerk account has no verified/usable email address yet" },
        { status: 400 },
      );
    }

    const preferredName =
      `${clerkUser.firstName || ""} ${clerkUser.lastName || ""}`.trim() ||
      clerkUser.username ||
      email.split("@")[0] ||
      "Player";

    // Grynd avatars are OFFICIAL icons only (users.selected_icon). Clerk's
    // externally-hosted imageUrl is deliberately NOT copied into the Grynd
    // profile system, so `clerkUser.imageUrl` never becomes a Grynd avatar.

    let rawPassword = crypto.randomBytes(32).toString("hex");

    try {
      const body = await req.json();
      if (body?.password) {
        rawPassword = String(body.password);
        try {
          await client.users.updateUser(clerkId, { password: rawPassword });
        } catch (err) {
          console.warn(" Clerk password update failed:", err);
          rawPassword = crypto.randomBytes(32).toString("hex");
        }
      }
    } catch {
      // Empty or invalid JSON body is acceptable for sync.
    }

    const passwordHash = await bcrypt.hash(rawPassword, 12);

    // The Clerk `user.created` webhook usually creates the local row before
    // the user reaches /sync, and concurrent requests (dev double-effects,
    // retries) can race this route. A plain check-then-insert turns those
    // races into 500s/409s and can misroute a brand-new player away from
    // onboarding, so the insert is atomic: ON CONFLICT (clerk_id) DO NOTHING
    // means exactly one racing request creates the row and the rest fall
    // through to the existing-row lookup below.
    let inserted;
    try {
      inserted = await db
        .insert(users)
        .values({
          clerkId,
          name: preferredName,
          email,
          password: passwordHash,
        })
        .onConflictDoNothing({ target: users.clerkId })
        .returning();
    } catch (error) {
      // Email belongs to a *different* account (not the webhook race, which
      // is covered by the clerk_id conflict target above).
      if ((error as { code?: string })?.code === "23505") {
        return NextResponse.json(
          { error: "An account with this email already exists in local DB" },
          { status: 409 },
        );
      }
      throw error;
    }

    const newUser = inserted?.[0];

    if (newUser) {
      await seedPlayerStats(newUser);
      return NextResponse.json(
        { message: "User synced successfully", user: newUser },
        { status: 201 },
      );
    }

    // Row already exists — created by the user.created webhook, a previous
    // sync, or a concurrent request that won the insert race.
    const existing = await db
      .select({ id: users.id, balance: users.balance, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (existing.length === 0) {
      // No row under this clerk_id but the email is taken by someone else.
      return NextResponse.json(
        { error: "An account with this email already exists in local DB" },
        { status: 409 },
      );
    }

    const existingUser = existing[0];

    // A brand-new player is one whose Clerk account was just created. The
    // webhook can beat /sync to the insert, so "did this request insert the
    // row" is not the right test for "is this a new user". Fresh accounts go
    // to the thank-you page; everyone else goes straight home as before.
    const isFreshAccount =
      Date.now() - Number(clerkUser.createdAt) < 15 * 60 * 1000;

    if (isFreshAccount) {
      await seedPlayerStats(existingUser);
      return NextResponse.json(
        { message: "User synced successfully", user: existingUser },
        { status: 200 },
      );
    }

    return NextResponse.json(
      { message: "User already exists", user: existingUser },
      { status: 200 },
    );
  } catch (error) {
    console.error(" Error in /api/sync-user:", error);
    await logError({
      errorType: "user_sync_error",
      errorMessage: error instanceof Error ? error.message : "User synchronization failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/sync-user",
      metadata: { operation: "sync_user", clerkId: "authenticated" },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

async function seedPlayerStats(user: { id: number; balance: string | null }) {
  // New player owns the official default icon + the full official catalog
  // (every enabled icon — migration 0129 backfills pre-existing accounts).
  await grantAllOfficialIcons(user.id);

  await db.execute(sql`
    INSERT INTO user_secret_stats (user_id, day_key, day_start_balance, last_known_balance)
    VALUES (${user.id}, ${new Date().toISOString().slice(0, 10)}, ${user.balance ?? "1000.00"}, ${user.balance ?? "1000.00"})
    ON CONFLICT (user_id) DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO user_stats (user_id)
    VALUES (${user.id})
    ON CONFLICT (user_id) DO NOTHING
  `);
}
