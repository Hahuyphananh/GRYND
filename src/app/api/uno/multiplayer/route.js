import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { unoGames, users } from "../../../../db/schema";

const MAX_SEATS = 6;

function getStore() {
  if (!globalThis.__unoMultiplayerRooms) {
    globalThis.__unoMultiplayerRooms = new Map();
  }
  return globalThis.__unoMultiplayerRooms;
}

function tableSummary(room) {
  return {
    code: room.code,
    name: room.settings.gameName,
    hostName: room.hostName,
    maxPlayers: room.settings.maxPlayers,
    occupiedSeats: room.players.length,
    betAmount: room.settings.betAmount,
    visibility: room.settings.visibility,
    started: room.started,
    activeGameId: room.activeGameId ?? null,
    settings: room.settings,
  };
}

function sanitizeSettings(settings = {}) {
  const maxPlayers = Math.min(Math.max(Number(settings.maxPlayers) || 4, 2), MAX_SEATS);
  return {
    gameName: String(settings.gameName || "UNO Table").slice(0, 60),
    visibility: settings.visibility === "public" ? "public" : "private",
    betAmount: Math.min(Math.max(Number(settings.betAmount) || 100, 1), 1000),
    maxPlayers,
    startingCards: [5, 7, 9].includes(Number(settings.startingCards)) ? Number(settings.startingCards) : 7,
    turnTimeSeconds: [20, 30, 45].includes(Number(settings.turnTimeSeconds)) ? Number(settings.turnTimeSeconds) : 30,
  };
}

function getNextOpenSeat(players, maxPlayers) {
  const preferred = [3, 2, 4, 1, 5, 0];
  return preferred.find((seat) => seat < maxPlayers && !players.some((p) => p.seatIndex === seat));
}

function generateDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Skip", "Reverse", "Draw Two"];
  const wilds = ["Wild", "Wild Draw Four"];
  const deck = [];

  for (const color of colors) {
    for (const value of values) {
      deck.push({ color, value });
      if (value !== "0") deck.push({ color, value });
    }
  }

  for (let i = 0; i < 4; i++) {
    for (const wild of wilds) deck.push({ color: "black", value: wild });
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

async function getCurrentUser() {
  const { userId } = await auth();
  if (!userId) return null;
  const user = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
  if (!user) return null;
  return user;
}

export async function GET(request) {
  const user = await getCurrentUser();
  if (!user) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const store = getStore();

  if (code) {
    const room = store.get(code.toUpperCase());
    if (!room) return new Response(JSON.stringify({ success: false, error: "Room not found" }), { status: 404 });

    const isParticipant = room.players.some((p) => p.userId === user.id);
    if (room.settings.visibility === "private" && !isParticipant) {
      return new Response(JSON.stringify({ success: false, error: "Room is private" }), { status: 403 });
    }

    return Response.json({
      success: true,
      currentUserId: user.id,
      room: {
        ...tableSummary(room),
        players: room.players,
        started: room.started,
      },
    });
  }

  const publicRooms = [...store.values()]
    .filter((room) => room.settings.visibility === "public" && !room.started)
    .map(tableSummary);

  return Response.json({ success: true, currentUserId: user.id, rooms: publicRooms });
}

export async function POST(request) {
  const user = await getCurrentUser();
  if (!user) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });

  const body = await request.json();
  const action = body?.action;
  const store = getStore();

  if (action === "create") {
    const settings = sanitizeSettings(body?.settings || {});
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const hostSeat = getNextOpenSeat([], settings.maxPlayers) ?? 0;
    const hostPlayer = {
      id: `${user.id}-host`,
      userId: user.id,
      name: user.name,
      type: "human",
      seatIndex: hostSeat,
      isHost: true,
      skipNextRound: false,
    };

    const room = {
      code,
      hostUserId: user.id,
      hostName: user.name,
      settings,
      inviteCode: code,
      players: [hostPlayer],
      started: false,
      activeGameId: null,
      createdAt: Date.now(),
    };
    store.set(code, room);

    return Response.json({ success: true, currentUserId: user.id, room: { ...tableSummary(room), players: room.players } });
  }

  const code = String(body?.code || "").toUpperCase();
  const room = store.get(code);
  if (!room) return new Response(JSON.stringify({ success: false, error: "Room not found" }), { status: 404 });

  if (action === "join") {
    if (room.started) return new Response(JSON.stringify({ success: false, error: "Game already started" }), { status: 409 });

    const alreadyIn = room.players.find((p) => p.userId === user.id);
    if (alreadyIn) return Response.json({ success: true, currentUserId: user.id, room: { ...tableSummary(room), players: room.players } });

    if (room.players.length >= room.settings.maxPlayers) {
      return new Response(JSON.stringify({ success: false, error: "Room is full" }), { status: 409 });
    }

    const seatIndex = getNextOpenSeat(room.players, room.settings.maxPlayers);
    if (seatIndex == null) {
      return new Response(JSON.stringify({ success: false, error: "No seat available" }), { status: 409 });
    }

    room.players.push({
      id: `${user.id}-${Date.now()}`,
      userId: user.id,
      name: user.name,
      type: "human",
      seatIndex,
      isHost: false,
      skipNextRound: false,
    });

    return Response.json({ success: true, currentUserId: user.id, room: { ...tableSummary(room), players: room.players } });
  }

  if (action === "toggle-skip") {
    const updatedPlayers = room.players.map((p) => {
      if (p.userId !== user.id) return p;
      return { ...p, skipNextRound: Boolean(body?.skipNextRound) };
    });
    room.players = updatedPlayers;
    return Response.json({ success: true, currentUserId: user.id, room: { ...tableSummary(room), players: room.players } });
  }

  if (action === "add-ai") {
    if (room.hostUserId !== user.id) return new Response(JSON.stringify({ success: false, error: "Only host can add AI" }), { status: 403 });
    if (room.started) return new Response(JSON.stringify({ success: false, error: "Game already started" }), { status: 409 });

    const seatIndex = Number(body?.seatIndex);
    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= room.settings.maxPlayers) {
      return new Response(JSON.stringify({ success: false, error: "Invalid seat" }), { status: 400 });
    }
    if (room.players.some((p) => p.seatIndex === seatIndex)) {
      return new Response(JSON.stringify({ success: false, error: "Seat occupied" }), { status: 409 });
    }

    room.players.push({
      id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      userId: null,
      name: `UNO Bot ${room.players.filter((p) => p.type === "ai").length + 1}`,
      type: "ai",
      seatIndex,
      isHost: false,
      skipNextRound: false,
    });

    return Response.json({ success: true, currentUserId: user.id, room: { ...tableSummary(room), players: room.players } });
  }

  if (action === "start") {
    if (room.hostUserId !== user.id) return new Response(JSON.stringify({ success: false, error: "Only host can start" }), { status: 403 });
    if (room.players.length < 2) return new Response(JSON.stringify({ success: false, error: "Need at least 2 players" }), { status: 400 });
    if (room.activeGameId) return new Response(JSON.stringify({ success: false, error: "A game is already running at this table." }), { status: 409 });

    const contenders = room.players
      .filter((p) => p.type === "human" || p.type === "ai")
      .filter((p) => !p.skipNextRound);
    const hostContender = contenders.find((p) => p.userId === room.hostUserId) ?? room.players.find((p) => p.userId === room.hostUserId);
    const opponent = contenders.find((p) => p.id !== hostContender?.id);
    if (!hostContender || !opponent) {
      return new Response(JSON.stringify({ success: false, error: "Need at least 2 active players (unchecked skip round)." }), { status: 400 });
    }

    const betAmount = Number(room.settings.betAmount);
    const deck = generateDeck();
    const hostHand = deck.splice(0, Number(room.settings.startingCards) || 7);
    const opponentHand = deck.splice(0, Number(room.settings.startingCards) || 7);
    let topCard;
    do {
      topCard = deck.pop();
    } while (topCard.value === "Wild" || topCard.value === "Wild Draw Four");
    const discardPile = [topCard];
    const firstTurn = Math.random() > 0.5 ? "player1" : "player2";

    const [hostDb] = await db.select().from(users).where(eq(users.id, hostContender.userId));
    if (!hostDb) return new Response(JSON.stringify({ success: false, error: "Host user not found." }), { status: 404 });
    if (Number(hostDb.balance) < betAmount) {
      return new Response(JSON.stringify({ success: false, error: "Host has insufficient balance for this bet." }), { status: 400 });
    }

    if (opponent.type === "human") {
      const [oppDb] = await db.select().from(users).where(eq(users.id, opponent.userId));
      if (!oppDb) return new Response(JSON.stringify({ success: false, error: "Opponent user not found." }), { status: 404 });
      if (Number(oppDb.balance) < betAmount) {
        return new Response(JSON.stringify({ success: false, error: "Opponent has insufficient balance." }), { status: 400 });
      }

      const [created] = await db.transaction(async (tx) => {
        await tx.update(users).set({ balance: (Number(hostDb.balance) - betAmount).toFixed(2) }).where(eq(users.id, hostDb.id));
        await tx.update(users).set({ balance: (Number(oppDb.balance) - betAmount).toFixed(2) }).where(eq(users.id, oppDb.id));
        return tx.insert(unoGames).values({
          userId: hostDb.id,
          player2Id: oppDb.id,
          betAmount: betAmount.toFixed(2),
          pot: (betAmount * 2).toFixed(2),
          result: "pending",
          payout: "0.00",
          winner: "pending",
          playerHand: [],
          aiHand: [],
          player1Hand: hostHand,
          player2Hand: opponentHand,
          deck,
          discardPile,
          topCard,
          currentColor: topCard.color,
          turn: firstTurn,
          status: "active",
        }).returning();
      });

      room.started = true;
      room.activeGameId = created.id;
      room.players = room.players.map((p) => ({ ...p, skipNextRound: false }));

      return Response.json({
        success: true,
        currentUserId: user.id,
        room: { ...tableSummary(room), players: room.players, started: true },
        game: {
          id: created.id,
          mode: "online",
          role: hostContender.userId === user.id ? "player1" : "player2",
          playerHand: hostContender.userId === user.id ? hostHand : opponentHand,
          opponentHandCount: hostContender.userId === user.id ? opponentHand.length : hostHand.length,
          topCard,
          currentColor: topCard.color,
          turn: firstTurn,
          newBalance: (Number(hostDb.balance) - betAmount).toFixed(2),
        },
      });
    }

    const aiHand = opponentHand;
    const [createdAi] = await db.transaction(async (tx) => {
      await tx.update(users).set({ balance: (Number(hostDb.balance) - betAmount).toFixed(2) }).where(eq(users.id, hostDb.id));
      return tx.insert(unoGames).values({
        userId: hostDb.id,
        player2Id: null,
        betAmount: betAmount.toFixed(2),
        pot: (betAmount * 2).toFixed(2),
        result: "pending",
        payout: "0.00",
        winner: "pending",
        playerHand: hostHand,
        aiHand,
        player1Hand: [],
        player2Hand: [],
        deck,
        discardPile,
        topCard,
        currentColor: topCard.color,
        turn: firstTurn === "player1" ? "player" : "ai",
        status: "active",
      }).returning();
    });

    room.started = true;
    room.activeGameId = createdAi.id;
    room.players = room.players.map((p) => ({ ...p, skipNextRound: false }));

    return Response.json({
      success: true,
      currentUserId: user.id,
      room: { ...tableSummary(room), players: room.players, started: true },
      game: {
        id: createdAi.id,
        mode: "ai",
        role: "player",
        playerHand: hostHand,
        aiHandCount: aiHand.length,
        topCard,
        currentColor: topCard.color,
        turn: firstTurn === "player1" ? "player" : "ai",
        newBalance: (Number(hostDb.balance) - betAmount).toFixed(2),
      },
    });
  }

  if (action === "leave") {
    if (room.activeGameId) {
      const [activeGame] = await db.select({ id: unoGames.id, status: unoGames.status, userId: unoGames.userId, player2Id: unoGames.player2Id })
        .from(unoGames)
        .where(eq(unoGames.id, room.activeGameId));
      if (activeGame?.status === "active" && (activeGame.userId === user.id || activeGame.player2Id === user.id)) {
        return new Response(JSON.stringify({ success: false, error: "You must finish or resign the game before leaving this table." }), { status: 409 });
      }
      if (!activeGame || activeGame.status !== "active") {
        room.activeGameId = null;
        room.started = false;
      }
    }

    room.players = room.players.filter((p) => p.userId !== user.id);

    if (room.players.length === 0) {
      store.delete(code);
      return Response.json({ success: true, currentUserId: user.id, removed: true });
    }

    if (room.hostUserId === user.id) {
      const newHost = room.players.find((p) => p.type === "human") || room.players[0];
      room.hostUserId = newHost.userId;
      room.hostName = newHost.name;
      room.players = room.players.map((p) => ({ ...p, isHost: p.userId === room.hostUserId }));
    }

    return Response.json({ success: true, currentUserId: user.id, room: { ...tableSummary(room), players: room.players } });
  }

  if (action === "sync-active-game") {
    if (!room.activeGameId) {
      return Response.json({ success: true, room: { ...tableSummary(room), players: room.players }, game: null });
    }

    const [activeGame] = await db.select().from(unoGames).where(eq(unoGames.id, room.activeGameId));
    if (!activeGame) {
      room.activeGameId = null;
      room.started = false;
      return Response.json({ success: true, room: { ...tableSummary(room), players: room.players }, game: null });
    }

    if (activeGame.status !== "active") {
      room.activeGameId = null;
      room.started = false;
    }

    const isHost = activeGame.userId === user.id;
    const isGuest = activeGame.player2Id === user.id;
    const isParticipant = isHost || isGuest;

    const role = isHost ? "player1" : isGuest ? "player2" : null;
    const playerHand = isHost ? activeGame.player1Hand : isGuest ? activeGame.player2Hand : [];
    const opponentHandCount = isHost ? activeGame.player2Hand?.length ?? 0 : activeGame.player1Hand?.length ?? 0;

    return Response.json({
      success: true,
      room: { ...tableSummary(room), players: room.players },
      game: isParticipant
        ? {
            id: activeGame.id,
            mode: activeGame.player2Id ? "online" : "ai",
            role: role || "spectator",
            playerHand,
            opponentHandCount,
            aiHandCount: activeGame.aiHand?.length ?? 0,
            topCard: activeGame.topCard,
            turn: activeGame.turn,
            status: activeGame.status,
          }
        : null,
    });
  }

  return new Response(JSON.stringify({ success: false, error: "Unknown action" }), { status: 400 });
}
