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
    };

    const room = {
      code,
      hostUserId: user.id,
      hostName: user.name,
      settings,
      players: [hostPlayer],
      started: false,
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
    });

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
    });

    return Response.json({ success: true, currentUserId: user.id, room: { ...tableSummary(room), players: room.players } });
  }

  if (action === "start") {
    if (room.hostUserId !== user.id) return new Response(JSON.stringify({ success: false, error: "Only host can start" }), { status: 403 });
    if (room.players.length < 2) return new Response(JSON.stringify({ success: false, error: "Need at least 2 players" }), { status: 400 });

    room.started = true;
    return Response.json({ success: true, currentUserId: user.id, room: { ...tableSummary(room), players: room.players, started: true } });
  }

  if (action === "leave") {
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

  return new Response(JSON.stringify({ success: false, error: "Unknown action" }), { status: 400 });
}
