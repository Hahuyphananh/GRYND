import bcrypt from "bcrypt";
import crypto from "crypto";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { logError } from "../../../lib/logError";
import { grantAllOfficialIcons } from "../../../lib/icons";
import { reconcileEmoteState } from "../../../lib/emotes";
import { validateObject } from "../../../lib/security/validation";

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

    // Strict allowlist on the optional body: only `password` may be sent.
    // An empty/invalid JSON body stays acceptable for a plain sync, but a
    // well-formed body carrying ANY other field — isAdmin, role, balance,
    // email, name, userId, ... — is rejected outright instead of being
    // silently ignored (nothing except `password` is ever read here, and
    // profile fields are owned by Clerk + the user.created webhook).
    try {
      const body = await req.json();
      if (body !== null && body !== undefined) {
        const parsed = await validateObject(body, {
          password: {
            type: "string",
            required: false,
            minLength: 6,
            maxLength: 72,
            default: null,
          },
        });
        if (!parsed.ok) return parsed.response;
        const suppliedPassword = parsed.data.password;
        if (suppliedPassword) {
          rawPassword = suppliedPassword;
          try {
            await client.users.updateUser(clerkId, { password: rawPassword });
          } catch (err) {
            console.warn(" Clerk password update failed:", err);
            rawPassword = crypto.randomBytes(32).toString("hex");
          }
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
      // Email is taken by an existing local row. The webhook race is covered
      // by the clerk_id conflict target above, so a 23505 here means the email
      // belongs to a row created under a *different* Clerk account — e.g. an
      // old instance (dev keys / previous clerk.grynd deployment) whose
      // clerkId no longer matches the session. Reassociate the existing row
      // to this session's clerkId so the account (balance, stats, items)
      // survives an instance switch instead of becoming "User not found".
      // Drizzle wraps the pg error (which carries code "23505") in a
      // DrizzleQueryError under `cause`, so check both surfaces.
      const pgCode =
        (error as { code?: string })?.code ??
        (error as { cause?: { code?: string } })?.cause?.code;
      if (pgCode === "23505") {
        const existingByEmail = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (existingByEmail.length === 0) {
          throw error;
        }

        await db
          .update(users)
          .set({ clerkId, name: preferredName, email })
          .where(eq(users.id, existingByEmail[0].id));

        return NextResponse.json(
          {
            message: "User re-associated with current Clerk account",
            user: { id: existingByEmail[0].id, clerkId },
          },
          { status: 200 },
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

  // New player also auto-owns the 8 FREE animated emotes with the default
  // loadout seeded (reconcileEmoteState is idempotent and only seeds on the
  // first free grant). Best-effort so an emote-system hiccup never blocks
  // account sync (the picker re-reconciles on first read anyway).
  await reconcileEmoteState(user.id).catch((err) =>
    console.warn("[sync-user] emote grant failed:", err),
  );

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
