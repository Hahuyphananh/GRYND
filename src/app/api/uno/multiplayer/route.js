import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";

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
    settings: room.settings,
    inviteCode: room.settings.visibility === "private" ? room.code : null,
    players: room.players,
    gameState: room.gameState
      ? {
          status: room.gameState.status,
          currentTurnPlayerId: room.gameState.currentTurnPlayerId,
          topCard: room.gameState.discardPile[room.gameState.discardPile.length - 1] || null,
          currentColor: room.gameState.currentColor,
          handsCount: Object.fromEntries(Object.entries(room.gameState.hands).map(([pid, hand]) => [pid, hand.length])),
          winnerId: room.gameState.winnerId,
          round: room.gameState.round,
        }
      : null,
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

function shuffle(arr) {
  const clone = [...arr];
  for (let i = clone.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
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
  return shuffle(deck);
}

function canPlayCard(card, topCard, currentColor) {
  if (!card || !topCard) return false;
  if (card.color === "black" || card.value === "Wild" || card.value === "Wild Draw Four") return true;
  return card.color === currentColor || card.value === topCard.value;
}

function applyCardEffect(gameState, card, chosenColor) {
  const active = gameState.turnOrder.filter((pid) => !gameState.resignedPlayerIds.includes(pid));
  if (active.length === 0) return;
  const idx = active.indexOf(gameState.currentTurnPlayerId);
  const nextIdx = (idx + 1) % active.length;
  const secondNextIdx = (idx + 2) % active.length;
  const normalized = String(card.value || "").toLowerCase();

  if (card.color === "black" && chosenColor) gameState.currentColor = chosenColor;
  else gameState.currentColor = card.color;

  if (normalized === "skip") {
    gameState.currentTurnPlayerId = active[secondNextIdx] ?? active[nextIdx];
    return;
  }

  if (normalized === "reverse") {
    gameState.turnOrder.reverse();
    const revActive = gameState.turnOrder.filter((pid) => !gameState.resignedPlayerIds.includes(pid));
    const revIdx = revActive.indexOf(gameState.currentTurnPlayerId);
    gameState.currentTurnPlayerId = revActive[(revIdx + 1) % revActive.length];
    return;
  }

  if (normalized === "draw two") {
    const target = active[nextIdx];
    for (let i = 0; i < 2 && gameState.deck.length > 0; i++) gameState.hands[target].push(gameState.deck.pop());
    gameState.currentTurnPlayerId = active[secondNextIdx] ?? active[nextIdx];
    return;
  }

  if (normalized === "wild draw four") {
    const target = active[nextIdx];
    for (let i = 0; i < 4 && gameState.deck.length > 0; i++) gameState.hands[target].push(gameState.deck.pop());
    gameState.currentTurnPlayerId = active[secondNextIdx] ?? active[nextIdx];
    return;
  }

  gameState.currentTurnPlayerId = active[nextIdx];
}

function getNextAiPlayer(room) {
  const gs = room.gameState;
  if (!gs || gs.status !== "active") return null;
  const pid = gs.currentTurnPlayerId;
  const player = room.players.find((p) => p.id === pid);
  if (!player || player.type !== "ai") return null;
  return player;
}

function runAiTurns(room) {
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const aiPlayer = getNextAiPlayer(room);
    if (!aiPlayer) return;
    const gs = room.gameState;
    const hand = gs.hands[aiPlayer.id] || [];
    const top = gs.discardPile[gs.discardPile.length - 1];
    const playableIdx = hand.findIndex((card) => canPlayCard(card, top, gs.currentColor));

    if (playableIdx >= 0) {
      const [card] = hand.splice(playableIdx, 1);
      const chosenColor = card.color === "black" ? ["red", "blue", "green", "yellow"][Math.floor(Math.random() * 4)] : null;
      gs.discardPile.push(chosenColor ? { ...card, color: chosenColor } : card);
      applyCardEffect(gs, card, chosenColor);
      if (hand.length === 0) {
        gs.status = "finished";
        gs.winnerId = aiPlayer.id;
        return;
      }
    } else if (gs.deck.length > 0) {
      hand.push(gs.deck.pop());
      const active = gs.turnOrder.filter((pid) => !gs.resignedPlayerIds.includes(pid));
      const idx = active.indexOf(aiPlayer.id);
      gs.currentTurnPlayerId = active[(idx + 1) % active.length];
    } else {
      gs.status = "finished";
      gs.winnerId = null;
      return;
    }
  }
}

async function settleWinner(room) {
  const gs = room.gameState;
  if (!gs || gs.status !== "finished" || gs.settled) return;
  gs.settled = true;
  if (!gs.winnerId) return;
  const winner = room.players.find((p) => p.id === gs.winnerId);
  if (!winner || !winner.userId) return;
  const pot = room.players.filter((p) => p.type === "human").length * room.settings.betAmount;
  const winnerUser = await db.query.users.findFirst({ where: eq(users.id, winner.userId) });
  if (!winnerUser) return;
  const newBalance = Number(winnerUser.balance) + pot;
  await db.update(users).set({ balance: newBalance.toFixed(2) }).where(eq(users.id, winner.userId));
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

    const myPlayer = room.players.find((p) => p.userId === user.id);
    return Response.json({
      success: true,
      currentUserId: user.id,
      myHand: myPlayer && room.gameState?.hands ? room.gameState.hands[myPlayer.id] || [] : [],
      room: tableSummary(room),
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
    if (Number(user.balance) < settings.betAmount) {
      return new Response(JSON.stringify({ success: false, error: "Insufficient tokens" }), { status: 400 });
    }
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const hostSeat = getNextOpenSeat([], settings.maxPlayers) ?? 0;

    await db.update(users)
      .set({ balance: (Number(user.balance) - settings.betAmount).toFixed(2) })
      .where(eq(users.id, user.id));

    const hostPlayer = {
      id: `${user.id}-host`,
      userId: user.id,
      name: user.name,
      type: "human",
      seatIndex: hostSeat,
      isHost: true,
      betStack: settings.betAmount,
      skipNextRound: false,
      resigned: false,
    };

    const room = {
      code,
      hostUserId: user.id,
      hostName: user.name,
      settings,
      players: [hostPlayer],
      started: false,
      gameState: null,
      createdAt: Date.now(),
    };
    store.set(code, room);

    return Response.json({ success: true, currentUserId: user.id, room: tableSummary(room) });
  }

  const code = String(body?.code || "").toUpperCase();
  const room = store.get(code);
  if (!room) return new Response(JSON.stringify({ success: false, error: "Room not found" }), { status: 404 });

  if (action === "join") {
    if (room.started) return new Response(JSON.stringify({ success: false, error: "Game already started" }), { status: 409 });

    const alreadyIn = room.players.find((p) => p.userId === user.id);
    if (alreadyIn) return Response.json({ success: true, currentUserId: user.id, room: tableSummary(room) });

    if (Number(user.balance) < room.settings.betAmount) {
      return new Response(JSON.stringify({ success: false, error: "Insufficient tokens" }), { status: 400 });
    }

    if (room.players.length >= room.settings.maxPlayers) {
      return new Response(JSON.stringify({ success: false, error: "Room is full" }), { status: 409 });
    }

    const seatIndex = getNextOpenSeat(room.players, room.settings.maxPlayers);
    if (seatIndex == null) {
      return new Response(JSON.stringify({ success: false, error: "No seat available" }), { status: 409 });
    }

    await db.update(users)
      .set({ balance: (Number(user.balance) - room.settings.betAmount).toFixed(2) })
      .where(eq(users.id, user.id));

    room.players.push({
      id: `${user.id}-${Date.now()}`,
      userId: user.id,
      name: user.name,
      type: "human",
      seatIndex,
      isHost: false,
      betStack: room.settings.betAmount,
      skipNextRound: false,
      resigned: false,
    });

    return Response.json({ success: true, currentUserId: user.id, room: tableSummary(room) });
  }

  if (action === "toggle-skip") {
    const me = room.players.find((p) => p.userId === user.id);
    if (!me) return new Response(JSON.stringify({ success: false, error: "Not seated" }), { status: 404 });
    me.skipNextRound = Boolean(body?.skipNextRound);
    return Response.json({ success: true, currentUserId: user.id, room: tableSummary(room) });
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
      betStack: room.settings.betAmount,
      skipNextRound: false,
      resigned: false,
    });

    return Response.json({ success: true, currentUserId: user.id, room: tableSummary(room) });
  }

  if (action === "start") {
    if (room.hostUserId !== user.id) return new Response(JSON.stringify({ success: false, error: "Only host can start" }), { status: 403 });
    const participants = room.players.filter((p) => !p.skipNextRound);
    if (participants.length < 2) return new Response(JSON.stringify({ success: false, error: "Need at least 2 players" }), { status: 400 });

    const deck = generateDeck();
    const hands = {};
    participants.forEach((p) => {
      hands[p.id] = deck.splice(0, room.settings.startingCards);
      p.resigned = false;
    });
    let topCard = deck.pop();
    while (topCard && topCard.color === "black") topCard = deck.pop();

    room.started = true;
    room.gameState = {
      status: "active",
      round: (room.gameState?.round || 0) + 1,
      deck,
      discardPile: [topCard],
      currentColor: topCard.color,
      currentTurnPlayerId: participants[0].id,
      turnOrder: participants.map((p) => p.id),
      hands,
      resignedPlayerIds: [],
      winnerId: null,
      settled: false,
    };

    runAiTurns(room);
    await settleWinner(room);
    return Response.json({ success: true, currentUserId: user.id, room: tableSummary(room) });
  }

  if (action === "play-card") {
    const me = room.players.find((p) => p.userId === user.id);
    if (!me || !room.gameState) return new Response(JSON.stringify({ success: false, error: "No active game" }), { status: 400 });
    if (room.gameState.status !== "active") return new Response(JSON.stringify({ success: false, error: "Round is finished" }), { status: 400 });
    if (room.gameState.currentTurnPlayerId !== me.id) return new Response(JSON.stringify({ success: false, error: "Not your turn" }), { status: 400 });

    const hand = room.gameState.hands[me.id] || [];
    const idx = hand.findIndex((c) => c.color === body.card?.color && c.value === body.card?.value);
    if (idx < 0) return new Response(JSON.stringify({ success: false, error: "Card not in hand" }), { status: 400 });

    const top = room.gameState.discardPile[room.gameState.discardPile.length - 1];
    const card = hand[idx];
    if (!canPlayCard(card, top, room.gameState.currentColor)) {
      return new Response(JSON.stringify({ success: false, error: "Invalid move" }), { status: 400 });
    }

    hand.splice(idx, 1);
    const chosenColor = card.color === "black" ? String(body?.chosenColor || "red") : null;
    room.gameState.discardPile.push(chosenColor ? { ...card, color: chosenColor } : card);
    applyCardEffect(room.gameState, card, chosenColor);

    if (hand.length === 0) {
      room.gameState.status = "finished";
      room.gameState.winnerId = me.id;
    }

    runAiTurns(room);
    await settleWinner(room);

    return Response.json({
      success: true,
      currentUserId: user.id,
      myHand: room.gameState.hands[me.id] || [],
      room: tableSummary(room),
    });
  }

  if (action === "draw-card") {
    const me = room.players.find((p) => p.userId === user.id);
    if (!me || !room.gameState) return new Response(JSON.stringify({ success: false, error: "No active game" }), { status: 400 });
    if (room.gameState.currentTurnPlayerId !== me.id) return new Response(JSON.stringify({ success: false, error: "Not your turn" }), { status: 400 });

    if (room.gameState.deck.length > 0) {
      room.gameState.hands[me.id].push(room.gameState.deck.pop());
    }

    const active = room.gameState.turnOrder.filter((pid) => !room.gameState.resignedPlayerIds.includes(pid));
    const idx = active.indexOf(me.id);
    room.gameState.currentTurnPlayerId = active[(idx + 1) % active.length];

    runAiTurns(room);
    await settleWinner(room);

    return Response.json({
      success: true,
      currentUserId: user.id,
      myHand: room.gameState.hands[me.id] || [],
      room: tableSummary(room),
    });
  }

  if (action === "resign") {
    const me = room.players.find((p) => p.userId === user.id);
    if (!me || !room.gameState) return new Response(JSON.stringify({ success: false, error: "No active game" }), { status: 400 });
    if (room.gameState.resignedPlayerIds.includes(me.id)) {
      return Response.json({ success: true, currentUserId: user.id, room: tableSummary(room) });
    }

    me.resigned = true;
    room.gameState.resignedPlayerIds.push(me.id);
    const alive = room.gameState.turnOrder.filter((pid) => !room.gameState.resignedPlayerIds.includes(pid));
    if (alive.length <= 1) {
      room.gameState.status = "finished";
      room.gameState.winnerId = alive[0] || null;
    } else if (room.gameState.currentTurnPlayerId === me.id) {
      room.gameState.currentTurnPlayerId = alive[0];
    }

    runAiTurns(room);
    await settleWinner(room);

    return Response.json({ success: true, currentUserId: user.id, room: tableSummary(room) });
  }

  if (action === "leave") {
    const me = room.players.find((p) => p.userId === user.id);
    if (!me) return new Response(JSON.stringify({ success: false, error: "Not seated" }), { status: 404 });

    if (room.gameState?.status === "active" && !me.resigned) {
      return new Response(JSON.stringify({ success: false, error: "You must resign or finish the round before leaving the table." }), { status: 400 });
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

    return Response.json({ success: true, currentUserId: user.id, room: tableSummary(room) });
  }

  return new Response(JSON.stringify({ success: false, error: "Unknown action" }), { status: 400 });
}
