import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../../db/client";
import { laneRunnerGames, users } from "../../../../db/schema";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import {
  createSignedSession,
  verifySignedSession,
} from "../../../../lib/serverSession";
import {
  buildProvablyFairSequence,
  DEFAULT_LANES,
  getMultiplier,
  getServerSeedHash,
  LANE_RUNNER_DIFFICULTIES,
  randomHex,
} from "../../../../lib/laneRunner";

const COOKIE_NAME = "lane_runner_session";

function withError(message, status = 400) {
  return NextResponse.json({ success: false, error: message }, { status });
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return withError("Unauthorized", 401);

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    if (action === "start") {
      const betAmount = Number(body.betAmount);
      const difficulty = String(body.difficulty || "easy").toLowerCase();
      const clientSeed = String(body.clientSeed || "default-client-seed");
      const config = LANE_RUNNER_DIFFICULTIES[difficulty];

      if (!config) return withError("Invalid difficulty");
      if (!Number.isFinite(betAmount) || betAmount <= 0)
        return withError("Invalid bet amount");

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);
      if (!user) return withError("User not found", 404);

      const [deducted] = await db
        .update(users)
        .set({ balance: sql`${users.balance} - ${betAmount}` })
        .where(
          sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${betAmount}`,
        )
        .returning({ balance: users.balance });

      if (!deducted) return withError("Insufficient balance");

      const serverSeed = randomHex(32);
      const serverSeedHash = getServerSeedHash(serverSeed);
      const nonce = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

      const outcomeSequence = buildProvablyFairSequence({
        serverSeed,
        clientSeed,
        nonce,
        difficulty,
        lanes: DEFAULT_LANES,
      });

      const session = {
        userDbId: user.id,
        userId,
        betAmount: Number(betAmount.toFixed(2)),
        difficulty,
        tilesPerLane: config.width,
        currentLane: 0,
        nonce,
        clientSeed,
        serverSeed,
        serverSeedHash,
        outcomeSequence,
        status: "active",
        createdAt: Date.now(),
      };

      const response = NextResponse.json({
        success: true,
        data: {
          serverSeedHash,
          nonce,
          clientSeed,
          currentLane: 0,
          multiplier: 1,
          potentialPayout: Number(betAmount.toFixed(2)),
          maxLanes: DEFAULT_LANES,
          tilesPerLane: config.width,
          newBalance: Number(deducted.balance),
          difficultyConfig: config,
        },
      });
      response.cookies.set(COOKIE_NAME, createSignedSession(session), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 30,
      });
      return response;
    }

    const token = req.cookies.get(COOKIE_NAME)?.value;
    const session = verifySignedSession(token);
    if (!session || session.userId !== userId || session.status !== "active") {
      return withError("No active lane runner session");
    }

    if (action === "pick") {
      const tileIndex = Number(body.tileIndex);
      if (
        !Number.isInteger(tileIndex) ||
        tileIndex < 0 ||
        tileIndex >= session.tilesPerLane
      ) {
        return withError("Invalid tile index");
      }

      const laneOutcome = session.outcomeSequence[session.currentLane];
      if (!laneOutcome) return withError("No more lanes. Cash out.");

      const lane = session.currentLane;
      const didFail = tileIndex === laneOutcome.badTile;
      const baseFair = {
        clientSeed: session.clientSeed,
        serverSeedHash: session.serverSeedHash,
        nonce: session.nonce,
      };

      if (didFail) {
        session.status = "lost";
        const response = NextResponse.json({
          success: true,
          data: {
            hasLost: true,
            hasCashedOut: false,
            lane,
            tileIndex,
            badTile: laneOutcome.badTile,
            safeTiles: laneOutcome.safeTiles,
            multiplier: getMultiplier(Math.max(lane, 0), 0, session.difficulty),
            payout: 0,
            gameOverReason: "bad_tile",
            fair: {
              ...baseFair,
              serverSeed: session.serverSeed,
            },
          },
        });

        // Track leaderboard stats for loss
        applyLeaderboardCounters({
          clerkId: userId,
          game: "Lane Runner",
          betAmount: session.betAmount,
          payout: 0,
        }).catch(() => {});

        await db.insert(laneRunnerGames).values({
          userId: session.userDbId,
          betAmount: String(session.betAmount.toFixed(2)),
          payout: "0.00",
          result: "lost",
          difficulty: session.difficulty,
          currentLane: lane,
          multiplier: String(
            getMultiplier(Math.max(lane, 0), 0, session.difficulty),
          ),
          clientSeed: session.clientSeed,
          serverSeedHash: session.serverSeedHash,
          serverSeed: session.serverSeed,
          nonce: session.nonce,
          outcomeSequence: session.outcomeSequence,
          status: "completed",
        });

        response.cookies.set(COOKIE_NAME, "", {
          httpOnly: true,
          path: "/",
          maxAge: 0,
        });
        return response;
      }

      session.currentLane += 1;
      const multiplier = getMultiplier(
        session.currentLane,
        0,
        session.difficulty,
      );
      const payout = Number((session.betAmount * multiplier).toFixed(2));
      const completedAllLanes = session.currentLane >= DEFAULT_LANES;

      if (completedAllLanes) {
        const [credited] = await db
          .update(users)
          .set({ balance: sql`${users.balance} + ${payout}` })
          .where(eq(users.clerkId, userId))
          .returning({ balance: users.balance });

        // Track leaderboard stats for completing all lanes
        applyLeaderboardCounters({
          clerkId: userId,
          game: "Lane Runner",
          betAmount: session.betAmount,
          payout,
        }).catch(() => {});

        await db.insert(laneRunnerGames).values({
          userId: session.userDbId,
          betAmount: String(session.betAmount.toFixed(2)),
          payout: String(payout.toFixed(2)),
          result: "completed",
          difficulty: session.difficulty,
          currentLane: session.currentLane,
          multiplier: String(multiplier),
          clientSeed: session.clientSeed,
          serverSeedHash: session.serverSeedHash,
          serverSeed: session.serverSeed,
          nonce: session.nonce,
          outcomeSequence: session.outcomeSequence,
          status: "completed",
        });

        const response = NextResponse.json({
          success: true,
          data: {
            hasLost: false,
            hasCashedOut: true,
            lane,
            tileIndex,
            badTile: laneOutcome.badTile,
            safeTiles: laneOutcome.safeTiles,
            currentLane: session.currentLane,
            multiplier,
            payout,
            newBalance: Number(credited?.balance ?? 0),
            fair: {
              ...baseFair,
              serverSeed: session.serverSeed,
            },
          },
        });
        response.cookies.set(COOKIE_NAME, "", {
          httpOnly: true,
          path: "/",
          maxAge: 0,
        });
        return response;
      }

      const response = NextResponse.json({
        success: true,
        data: {
          hasLost: false,
          hasCashedOut: false,
          lane,
          tileIndex,
          badTile: laneOutcome.badTile,
          safeTiles: laneOutcome.safeTiles,
          currentLane: session.currentLane,
          multiplier,
          payout,
          fair: baseFair,
        },
      });

      response.cookies.set(COOKIE_NAME, createSignedSession(session), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 30,
      });
      return response;
    }

    if (action === "cashout") {
      const multiplier = getMultiplier(
        session.currentLane,
        0,
        session.difficulty,
      );
      const payout = Number((session.betAmount * multiplier).toFixed(2));

      const [credited] = await db
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout}` })
        .where(eq(users.clerkId, userId))
        .returning({ balance: users.balance });

      // Track leaderboard stats for cashout
      applyLeaderboardCounters({
        clerkId: userId,
        game: "Lane Runner",
        betAmount: session.betAmount,
        payout,
      }).catch(() => {});

      await db.insert(laneRunnerGames).values({
        userId: session.userDbId,
        betAmount: String(session.betAmount.toFixed(2)),
        payout: String(payout.toFixed(2)),
        result: "cashed_out",
        difficulty: session.difficulty,
        currentLane: session.currentLane,
        multiplier: String(multiplier),
        clientSeed: session.clientSeed,
        serverSeedHash: session.serverSeedHash,
        serverSeed: session.serverSeed,
        nonce: session.nonce,
        outcomeSequence: session.outcomeSequence,
        status: "completed",
      });

      const response = NextResponse.json({
        success: true,
        data: {
          hasLost: false,
          hasCashedOut: true,
          multiplier,
          payout,
          newBalance: Number(credited?.balance ?? 0),
          fair: {
            clientSeed: session.clientSeed,
            serverSeedHash: session.serverSeedHash,
            serverSeed: session.serverSeed,
            nonce: session.nonce,
          },
        },
      });
      response.cookies.set(COOKIE_NAME, "", {
        httpOnly: true,
        path: "/",
        maxAge: 0,
      });
      return response;
    }

    return withError("Invalid action");
  } catch (error) {
    console.error("Lane runner API error", error);
    return withError("Server error", 500);
  }
}
