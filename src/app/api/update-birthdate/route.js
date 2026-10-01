import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { cacheDelete } from "../../../lib/redis/cache";
import { CacheKeys } from "../../../lib/redis/keys";
import { parseAndValidateJson } from "../../../lib/security/validation";
import { findProfanity } from "../../../lib/moderation/profanity";
import { searchNameFor } from "../../../lib/searchName";
import {
  calculateAge,
  MAXIMUM_AGE,
  MINIMUM_AGE,
} from "../../../lib/ageVerification";

export async function POST(req) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
      },
    );
  }

  // Strict allowlist: only `birthDate` (and the signup username) may be sent.
  // A yyyy-mm-dd string is enforced BEFORE the age math, so an unparseable date
  // can no longer slide through as NaN and silently skip the 18+ gate.
  const parsed = await parseAndValidateJson(req, {
    birthDate: {
      type: "string",
      required: true,
      maxLength: 40,
      pattern: /^\d{4}-\d{2}-\d{2}$/,
    },
    // The username the player chose at signup. This route is the mandatory
    // gate between a fresh account and the rest of the app, so it is where the
    // handle is captured and written to Clerk publicMetadata — /sync and the
    // user.created webhook then read it instead of the provider's real name.
    username: {
      type: "string",
      required: false,
      maxLength: 40,
      default: null,
    },
  });
  if (!parsed.ok) return parsed.response;

  const birthDate = parsed.data.birthDate;

  // Validate the chosen username BEFORE anything is written. Published on the
  // leaderboard/reviews, so length and the profanity filter are both enforced
  // server-side (the client checks are only a preview).
  const rawUsername =
    typeof parsed.data.username === "string" ? parsed.data.username.trim() : "";
  let chosenUsername = null;
  if (rawUsername) {
    if (rawUsername.length < 2 || rawUsername.length > 20) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Username must be between 2 and 20 characters",
        }),
        { status: 400 },
      );
    }
    if (findProfanity(rawUsername) !== null) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "That username isn't allowed. Please choose a different one.",
        }),
        { status: 400 },
      );
    }
    chosenUsername = rawUsername;
  }

  // Calendar-based age. The server is the authoritative calculation — the
  // client-side checks only pre-empt the request (src/lib/ageVerification.ts).
  const age = calculateAge(birthDate);

  if (age === null || age < MINIMUM_AGE || age > MAXIMUM_AGE) {
    return new Response(
      JSON.stringify({ success: false, error: "Must be 18+" }),
      {
        status: 403,
      },
    );
  }

  try {
    // Update age (and the chosen username, when supplied) in DB. `search_name`
    // is kept in lockstep with `name` — it is the folded match key
    // /api/friends/search reads (src/lib/searchName.ts).
    await db
      .update(users)
      .set({
        age,
        ...(chosenUsername
          ? { name: chosenUsername, searchName: searchNameFor(chosenUsername) }
          : {}),
      })
      .where(eq(users.clerkId, userId));

    // Invalidate the middleware age-gate cache so the next navigation
    // reflects the new age instead of the cached value.
    await cacheDelete(CacheKeys.userAge(userId)).catch(() => {});

    // Persist the actual birth date to Clerk public metadata — the privacy
    // policy promises DOB is stored for age verification, and
    // useAgeVerification() reads it from there. Best-effort: if Clerk
    // fails, the DB age still gates access, so don't fail the request.
    try {
      const client = await clerkClient();
      await client.users.updateUser(userId, {
        publicMetadata: {
          birthDate,
          // Persisted so whichever signup path creates the local row first
          // (webhook or /sync) reads the chosen handle instead of the real
          // name. Harmless when no username was supplied.
          ...(chosenUsername ? { username: chosenUsername } : {}),
        },
      });
    } catch (clerkErr) {
      console.error("Error persisting birthDate to Clerk metadata:", clerkErr);
    }

    return new Response(JSON.stringify({ success: true, age }), {
      status: 200,
    });
  } catch (error) {
    console.error("Error updating age:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      {
        status: 500,
      },
    );
  }
}
