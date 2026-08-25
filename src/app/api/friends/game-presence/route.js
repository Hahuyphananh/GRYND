import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { cacheGet, cacheSet } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

function parseCurrentGameId(currentGameId) {
  if (!currentGameId) return { gameKey: null, gameId: null };
  const raw = String(currentGameId);
  const [gameKeyPart, gameIdPart] = raw.split(":");
  return {
    gameKey: gameKeyPart || null,
    gameId: gameIdPart ? Number(gameIdPart) || gameIdPart : null,
  };
}

export async function GET() {
  const sql = getNeonSql();
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401 },
      );
    }

    // Short per-user cache: the home + casino tabs each poll this endpoint
    // (now every 60s), and a user can have several tabs open. Caching the
    // serialized feed for a few seconds collapses those overlapping reads
    // into one DB join. No-op (straight DB path) when Redis is unavailable.
    const cacheKey = CacheKeys.friendPresence(userId);
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const meRes = await sql`
      SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1
    `;

    if (!meRes.length) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404 },
      );
    }

    const meId = Number(meRes[0].id);

    const rows = await sql`
      SELECT
        u.id AS friend_id,
        u.name,
        u.profile_picture,
        p.last_seen,
        p.status,
        p.current_game_id,
        CASE
          WHEN p.last_seen IS NULL THEN 'offline'::text
          WHEN p.last_seen < NOW() - INTERVAL '6 minutes' THEN 'offline'::text
          ELSE p.status::text
        END AS computed_status
      FROM friend_relations fr
      JOIN users u ON u.id = fr.friend_id
      LEFT JOIN user_presence p ON p.clerk_id = u.clerk_id
      WHERE fr.user_id = ${meId}
      ORDER BY
        CASE
          WHEN p.last_seen IS NULL THEN 0
          WHEN p.last_seen < NOW() - INTERVAL '6 minutes' THEN 0
          ELSE 1
        END DESC,
        p.last_seen DESC NULLS LAST,
        u.name ASC
    `;

    const byGame = {};
    const byFriend = {};

    for (const row of rows) {
      const parsed = parseCurrentGameId(row.current_game_id);
      const presenceState = row.computed_status || "offline";

      const friendPayload = {
        id: row.friend_id,
        name: row.name,
        profilePicture: row.profile_picture,
        gameId: parsed.gameId,
      };

      if (presenceState === "in_game" && parsed.gameKey) {
        if (!byGame[parsed.gameKey]) byGame[parsed.gameKey] = [];
        byGame[parsed.gameKey].push(friendPayload);
      }

      byFriend[row.friend_id] = {
        ...friendPayload,
        gameKey: parsed.gameKey,
        lastSeenAt: row.last_seen || null,
        presenceState,
      };
    }

    const payload = {
      success: true,
      data: rows,
      byGame,
      byFriend,
    };

    // Cache the built feed (fire-and-forget; never block the response) so
    // overlapping tab polls share one DB join.
    await cacheSet(cacheKey, payload, CacheTTL.friendPresence).catch(() => {});

    return new Response(
      JSON.stringify(payload),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[FRIENDS_GAME_PRESENCE_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Could not fetch presence",
        data: [],
        byGame: {},
        byFriend: {},
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
