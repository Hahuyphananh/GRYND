import { auth } from "@clerk/nextjs/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../../db/client";
import { glows, tokenSubscriptions, users } from "../../../../db/schema";
import { unoRoomStore } from "../../../../lib/unoRoomStore";
import { resolvePrestigeBadge } from "../../../../lib/prestige";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../../../../lib/stripe/subscriptions";

const MAX_SEATS = 6;
const HOUSE_EDGE_PERCENT = 5;function getStore() {
  return unoRoomStore;
}

// Server-resolved prestige badge for a users row — raw prestige columns
// never leave the server; only the label (or null) is stored on the
// in-memory player object so every room payload carries it automatically.
function prestigeBadgeForUser(user) {
  if (!user) return null;
  return resolvePrestigeBadge({
    xp: user.xp,
    prestigeLevel: user.prestigeLevel,
    showPrestigeBadge: user.showPrestigeBadge,
  });
}

/** Resolve a users row's official Grynd icon key + equipped name color
 *  (battlepass glow wins; the Grynd+ chat color only surfaces for active
 *  members). Raw columns never leave the server — only the resolved
 *  values are stamped onto the in-memory player object. Best-effort:
 *  a lookup failure returns defaults so seat rendering never breaks. */
async function seatIdentityForUser(user) {
  if (!user) return { iconKey: null, nameColor: null };
  const [row] = await db
    .select({
      iconKey: users.selectedIcon,
      chatColor: users.chatColor,
      glowColor: glows.color,
      isPremium: sql`(${tokenSubscriptions.status} IS NOT NULL)`,
    })
    .from(users)
    .leftJoin(
      glows,
      and(eq(glows.key, users.selectedGlow), eq(glows.enabled, true)),
    )
    .leftJoin(
      tokenSubscriptions,
      and(
        eq(tokenSubscriptions.clerkId, users.clerkId),
        inArray(tokenSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES),
      ),
    )
    .where(eq(users.clerkId, user.clerkId))
    .limit(1);
  return {
    iconKey: row?.iconKey || null,
    nameColor:
      row?.glowColor ||
      (Boolean(row?.isPremium) ? row?.chatColor || null : null) ||
      null,
  };
}

function tableSummary(room) {
  return {
    code: room.code,
    name: room.settings.gameName,
    hostName: room.hostName,
    maxPlayers: room.settings.maxPlayers,
    occupiedSeats: room.players.filter((p) => p.seatIndex !== null).length,
    betAmount: room.settings.betAmount,
    visibility: room.settings.visibility,
    started: room.started,
    activeGameId: room.activeGameId ?? null,
    settings: room.settings,
  };
}

function sanitizeSettings(settings = {}) {
  const maxPlayers = Math.min(
    Math.max(Number(settings.maxPlayers) || 4, 2),
    MAX_SEATS,
  );
  return {
    gameName: String(settings.gameName || "UNO Table").slice(0, 60),
    visibility: settings.visibility === "public" ? "public" : "private",
    betAmount: Math.min(Math.max(Number(settings.betAmount) || 100, 1), 1000),
    maxPlayers,
    startingCards: [5, 7, 9].includes(Number(settings.startingCards))
      ? Number(settings.startingCards)
      : 7,
    turnTimeSeconds: [20, 30, 45].includes(Number(settings.turnTimeSeconds))
      ? Number(settings.turnTimeSeconds)
      : 30,
  };
}

function getNextOpenSeat(players, maxPlayers) {
  const preferred = [3, 2, 4, 1, 5, 0];
  return preferred.find(
    (seat) => seat < maxPlayers && !players.some((p) => p.seatIndex === seat),
  );
}

function generateDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "Skip",
    "Reverse",
    "Draw Two",
  ];
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

function norm(v) {
  return String(v || "").toLowerCase();
}

function isPlayable(card, topCard, currentColor, hand = []) {
  const value = norm(card.value);
  if (!topCard) return true;
  if (value === "wild") return true;
  if (value === "wild draw four") {
    const hasMatch = hand.some((c) => norm(c.color) === norm(currentColor));
    return !hasMatch;
  }
  return (
    norm(card.color) === norm(currentColor) || value === norm(topCard.value)
  );
}

function ensureDeck(state) {
  if (state.deck.length > 0) return;
  if (state.discardPile.length <= 1) return;
  const top = state.discardPile[state.discardPile.length - 1];
  const rest = state.discardPile.slice(0, -1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  state.deck = rest;
  state.discardPile = [top];
}

function drawFor(state, playerId, count = 1) {
  const hand = state.hands[playerId] || [];
  for (let i = 0; i < count; i++) {
    ensureDeck(state);
    const card = state.deck.pop();
    if (!card) break;
    hand.push(card);
  }
  state.hands[playerId] = hand;
}

function advanceIndex(state, steps = 1) {
  const len = state.players.length;
  const delta = state.direction;
  state.turnIndex = (((state.turnIndex + steps * delta) % len) + len) % len;
}

function applyCardEffect(state, playerId, playedCard, chosenColor) {
  const value = norm(playedCard.value);

  //  Inject chosen color INTO the card for UI
  let finalCard = { ...playedCard };

  if (value === "wild" || value === "wild draw four") {      finalCard.color = norm(chosenColor); // THIS FIXES DISPLAY
  }

  //  Push ONLY ONCE
  state.discardPile.push(finalCard);

  //  Update rule color
  state.currentColor =
    value === "wild" || value === "wild draw four"
      ? norm(chosenColor)
      : norm(playedCard.color);

  const playerHand = state.hands[playerId] || [];

  if (playerHand.length === 0) {
    state.status = "finished";
    state.winnerId = playerId;
    return;
  }

  if (value === "reverse") {
    if (state.players.length === 2) {
      advanceIndex(state, 2);
    } else {
      state.direction *= -1;
      advanceIndex(state, 1);
    }
    return;
  }

  if (value === "skip") {
    advanceIndex(state, 2);
    return;
  }

  if (value === "draw two" || value === "+2") {
    const target =
      state.players[
        (((state.turnIndex + state.direction) % state.players.length) +
          state.players.length) %
          state.players.length
      ];
    drawFor(state, target.id, 2);
    advanceIndex(state, 2);
    return;
  }

  if (value === "wild draw four" || value === "+4") {
    const target =
      state.players[
        (((state.turnIndex + state.direction) % state.players.length) +
          state.players.length) %
          state.players.length
      ];
    drawFor(state, target.id, 4);
    advanceIndex(state, 2);
    return;
  }

  advanceIndex(state, 1);
}

function chooseAiCard(state, aiId) {
  const topCard = state.discardPile[state.discardPile.length - 1];
  const hand = state.hands[aiId] || [];
  return (
    hand.find((card) => isPlayable(card, topCard, state.currentColor, hand)) ||
    null
  );
}

function aiChooseColor(hand) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand || []) {
    if (counts[norm(c.color)] != null) counts[norm(c.color)] += 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "red";
}

async function settleWinner(room, winnerId) {
  if (!winnerId || !room?.activeState) return;
  if (room.activeState.settled) return;
  const winner = room.activeState.players.find((p) => p.id === winnerId);
  if (!winner || winner.type === "ai" || !winner.userId) return;

  const payout = Number(
    (room.activeState.pot * ((100 - HOUSE_EDGE_PERCENT) / 100)).toFixed(2),
  );
  await db
    .update(users)
    .set({ balance: sql`${users.balance} + ${payout}` })
    .where(eq(users.id, winner.userId));
  room.activeState.settled = true;
}

function serializeGameForUser(room, userId) {
  const active = room.activeState;
  if (!active) return null;
  const me = active.players.find((p) => p.userId === userId);
  const meId = me?.id ?? null;
  const turnPlayer = active.players[active.turnIndex];

  return {
    id: room.activeGameId,
    code: room.code,
    mode: "table",
    role: meId,
    mySeatIndex: me?.seatIndex ?? null,
    playerHand: meId ? active.hands[meId] || [] : [],    handCounts: active.players.map((p) => ({
      playerId: p.id,
      seatIndex: p.seatIndex,
      name: p.name,
      type: p.type,
      count: (active.hands[p.id] || []).length,
      isHost: Boolean(p.isHost),
      prestigeBadge: p.prestigeBadge ?? null,
      iconKey: p.iconKey ?? null,
      nameColor: p.nameColor ?? null,
    })),

    topCard: active.discardPile[active.discardPile.length - 1] || null,
    currentColor: active.currentColor,
    turnPlayerId: turnPlayer?.id || null,
    status: active.status,
    winnerId: active.winnerId,
    winner: active.winnerId,
    pot: active.pot,
  };
}

async function getCurrentUser() {
  const { userId } = await auth();
  if (!userId) return null;
  const user = await db.query.users.findFirst({
    where: eq(users.clerkId, userId),
  });
  if (!user) return null;
  return user;
}

function runSingleAiTurn(room) {
  const state = room.activeState;
  if (!state || state.status !== "active") return false;

  const current = state.players[state.turnIndex];
  if (!current || current.type !== "ai") return false;

  const card = chooseAiCard(state, current.id);

  if (!card) {
    drawFor(state, current.id, 1);

    const fresh = state.hands[current.id].at(-1);
    const top = state.discardPile.at(-1);

    if (
      fresh &&
      isPlayable(fresh, top, state.currentColor, state.hands[current.id])
    ) {
      state.hands[current.id].pop();

      const chosenColor =
        norm(fresh.color) === "black"
          ? aiChooseColor(state.hands[current.id])
          : null;

      applyCardEffect(state, current.id, fresh, chosenColor);
    } else {
      advanceIndex(state, 1);
    }

    return true;
  }

  const hand = state.hands[current.id];
  const idx = hand.findIndex(
    (c) => c.color === card.color && c.value === card.value,
  );
  if (idx >= 0) hand.splice(idx, 1);

  const chosenColor = norm(card.color) === "black" ? aiChooseColor(hand) : null;

  applyCardEffect(state, current.id, card, chosenColor);

  return true;
}

function scheduleAi(room) {
  if (room.aiTimeout) return;

  room.aiTimeout = setTimeout(() => {
    room.aiTimeout = null;

    let safety = 0;
    while (safety < 8) {
      const didPlay = runSingleAiTurn(room);
      if (!didPlay) return;
      const state = room.activeState;
      if (
        !state ||
        state.status !== "active" ||
        state.players[state.turnIndex]?.type !== "ai"
      )
        break;
      safety += 1;
    }

    const state = room.activeState;
    if (
      state &&
      state.status === "active" &&
      state.players[state.turnIndex]?.type === "ai"
    ) {
      scheduleAi(room);
    }
  }, 900);
}

export async function GET(request) {
  const user = await getCurrentUser();
  if (!user)
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401 },
    );

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const store = getStore();

  if (code) {
    const room = store.get(code.toUpperCase());
    if (!room)
      return new Response(
        JSON.stringify({ success: false, error: "Room not found" }),
        { status: 404 },
      );

    const isParticipant = room.players.some((p) => p.userId === user.id);
    // Allow code lookup for private rooms.
    // Actual joining still handled in POST action join.
    if (room.settings.visibility === "private" && !isParticipant) {
      return Response.json({
        success: true,
        currentUserId: user.id,
        room: {
          ...tableSummary(room),
          players: room.players,
          started: room.started,
          requiresJoin: true,
        },
      });
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

  return Response.json({
    success: true,
    currentUserId: user.id,
    rooms: publicRooms,
  });
}

export async function POST(request) {
  const user = await getCurrentUser();
  if (!user)
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401 },
    );

  const body = await request.json();
  const action = body?.action;
  const store = getStore();

  if (action === "create") {
    const settings = sanitizeSettings(body?.settings || {});
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const hostIdentity = await seatIdentityForUser(user);
    const hostPlayer = {
      id: `${user.id}-host`,
      userId: user.id,
      name: user.name,
      type: "human",
      seatIndex: null,
      isHost: true,
      skipNextRound: false,
      prestigeBadge: prestigeBadgeForUser(user),
      iconKey: hostIdentity.iconKey,
      nameColor: hostIdentity.nameColor,
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
      activeState: null,
      createdAt: Date.now(),
    };
    store.set(code, room);

    return Response.json({
      success: true,
      currentUserId: user.id,
      room: { ...tableSummary(room), players: room.players },
    });
  }

  const code = String(body?.code || "").toUpperCase();
  const room = store.get(code);
  if (!room)
    return new Response(
      JSON.stringify({ success: false, error: "Room not found" }),
      { status: 404 },
    );

  if (action === "join") {
    if (room.started)
      return new Response(
        JSON.stringify({ success: false, error: "Game already started" }),
        { status: 409 },
      );

    const alreadyIn = room.players.find((p) => p.userId === user.id);
    if (alreadyIn)
      return Response.json({
        success: true,
        currentUserId: user.id,
        room: { ...tableSummary(room), players: room.players },
      });

    return Response.json({
      success: true,
      currentUserId: user.id,
      room: { ...tableSummary(room), players: room.players },
      needsSeatSelection: true,
    });
  }

  if (action === "toggle-skip") {
    room.players = room.players.map((p) =>
      p.userId !== user.id
        ? p
        : { ...p, skipNextRound: Boolean(body?.skipNextRound) },
    );
    return Response.json({
      success: true,
      currentUserId: user.id,
      room: { ...tableSummary(room), players: room.players },
    });
  }

  if (action === "sit-human") {
    if (room.started)
      return new Response(
        JSON.stringify({ success: false, error: "Game already started" }),
        { status: 409 },
      );

    const existing = room.players.find((p) => p.userId === user.id);
    const seatIndex = Number(body?.seatIndex);
    if (
      !Number.isInteger(seatIndex) ||
      seatIndex < 0 ||
      seatIndex >= room.settings.maxPlayers
    ) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid seat" }),
        { status: 400 },
      );
    }
    if (
      room.players.some(
        (p) => p.seatIndex === seatIndex && p.userId !== user.id,
      )
    ) {
      return new Response(
        JSON.stringify({ success: false, error: "Seat occupied" }),
        { status: 409 },
      );
    }

    if (existing) {
      existing.seatIndex = seatIndex;
    } else {
      const joinIdentity = await seatIdentityForUser(user);
      room.players.push({
        id: `${user.id}-${Date.now()}`,
        userId: user.id,
        name: user.name,
        type: "human",
        seatIndex,
        isHost: false,
        skipNextRound: false,
        prestigeBadge: prestigeBadgeForUser(user),
        iconKey: joinIdentity.iconKey,
        nameColor: joinIdentity.nameColor,
      });
    }

    return Response.json({
      success: true,
      currentUserId: user.id,
      room: { ...tableSummary(room), players: room.players },
    });
  }

  if (action === "add-ai") {
    if (room.hostUserId !== user.id)
      return new Response(
        JSON.stringify({ success: false, error: "Only host can add AI" }),
        { status: 403 },
      );
    if (room.started)
      return new Response(
        JSON.stringify({ success: false, error: "Game already started" }),
        { status: 409 },
      );

    const seatIndex = Number(body?.seatIndex);
    if (
      !Number.isInteger(seatIndex) ||
      seatIndex < 0 ||
      seatIndex >= room.settings.maxPlayers
    ) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid seat" }),
        { status: 400 },
      );
    }
    if (room.players.some((p) => p.seatIndex === seatIndex)) {
      return new Response(
        JSON.stringify({ success: false, error: "Seat occupied" }),
        { status: 409 },
      );
    }

    room.players.push({
      id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      userId: null,
      name: `UNO Bot ${room.players.filter((p) => p.type === "ai").length + 1}`,
      type: "ai",
      seatIndex,
      isHost: false,
      skipNextRound: false,
      iconKey: null,
      nameColor: null,
    });

    return Response.json({
      success: true,
      currentUserId: user.id,
      room: { ...tableSummary(room), players: room.players },
    });
  }

  if (action === "start") {
    if (room.hostUserId !== user.id)
      return new Response(
        JSON.stringify({ success: false, error: "Only host can start" }),
        { status: 403 },
      );
    if (room.activeState?.status === "active")
      return new Response(
        JSON.stringify({
          success: false,
          error: "A game is already running at this table.",
        }),
        { status: 409 },
      );

    const contenders = room.players
      .filter((p) => p.seatIndex !== null)
      .filter((p) => p.type === "human" || p.type === "ai")
      .filter((p) => !p.skipNextRound)
      .sort((a, b) => a.seatIndex - b.seatIndex);

    if (contenders.length < 2) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Need at least 2 active players (unchecked skip round).",
        }),
        { status: 400 },
      );
    }

    const betAmount = Number(room.settings.betAmount);
    const humanIds = contenders
      .filter((p) => p.type === "human")
      .map((p) => p.userId);
    const balances = humanIds.length
      ? await db
          .select({ id: users.id, balance: users.balance })
          .from(users)
          .where(inArray(users.id, humanIds))
      : [];
    const byId = new Map(balances.map((u) => [u.id, Number(u.balance)]));

    for (const p of contenders.filter((p) => p.type === "human")) {
      const b = byId.get(p.userId) ?? 0;
      if (b < betAmount) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `${p.name} has insufficient balance for this bet.`,
          }),
          { status: 400 },
        );
      }
    }

    if (humanIds.length) {
      await db.transaction(async (tx) => {
        for (const id of humanIds) {
          await tx
            .update(users)
            .set({ balance: sql`${users.balance} - ${betAmount}` })
            .where(eq(users.id, id));
        }
      });
    }

    const deck = generateDeck();
    const hands = {};
    for (const p of contenders) {
      hands[p.id] = deck.splice(0, Number(room.settings.startingCards) || 7);
    }

    let topCard;
    do {
      topCard = deck.pop();
    } while (
      topCard &&
      (topCard.value === "Wild" || topCard.value === "Wild Draw Four")
    );

    const activeState = {
      players: contenders,
      hands,
      deck,
      discardPile: [topCard],
      currentColor: topCard?.color || "red",
      direction: 1,
      turnIndex: 0,
      status: "active",
      winnerId: null,
      betAmount,
      pot: betAmount * contenders.length,
    };

    room.started = true;
    room.activeGameId = `table-${room.code}-${Date.now()}`;
    room.activeState = activeState;
    room.players = room.players.map((p) => ({ ...p, skipNextRound: false }));

    scheduleAi(room);

    return Response.json({
      success: true,
      currentUserId: user.id,
      room: { ...tableSummary(room), players: room.players, started: true },
      game: serializeGameForUser(room, user.id),
    });
  }

  if (action === "leave") {
    if (
      room.activeState?.status === "active" &&
      room.activeState.players.some((p) => p.userId === user.id)
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "You must finish or resign the game before leaving this table.",
        }),
        { status: 409 },
      );
    }

    room.players = room.players.filter((p) => p.userId !== user.id);

    if (room.players.length === 0) {
      store.delete(code);
      return Response.json({
        success: true,
        currentUserId: user.id,
        removed: true,
      });
    }

    if (room.hostUserId === user.id) {
      const newHost =
        room.players.find((p) => p.type === "human") || room.players[0];
      room.hostUserId = newHost.userId;
      room.hostName = newHost.name;
      room.players = room.players.map((p) => ({
        ...p,
        isHost: p.userId === room.hostUserId,
      }));
    }

    return Response.json({
      success: true,
      currentUserId: user.id,
      room: { ...tableSummary(room), players: room.players },
    });
  }

  if (action === "sync-active-game" || action === "check-game") {
    if (!room.activeState) {
      return Response.json({
        success: true,
        room: { ...tableSummary(room), players: room.players },
        game: null,
      });
    }
    scheduleAi(room);

    if (room.activeState.status === "finished") {
      await settleWinner(room, room.activeState.winnerId);
      room.started = false;
    }

    const data = serializeGameForUser(room, user.id);
    return Response.json({
      success: true,
      room: { ...tableSummary(room), players: room.players },
      game: data,
      status: room.activeState.status,
      data,
      shouldReturnToLobby: !data?.role,
    });
  }

  if (action === "play-card") {
    const state = room.activeState;
    if (!state || state.status !== "active")
      return new Response(
        JSON.stringify({ success: false, error: "No active game" }),
        { status: 400 },
      );

    const me = state.players.find((p) => p.userId === user.id);
    if (!me)
      return new Response(
        JSON.stringify({ success: false, error: "Forbidden" }),
        { status: 403 },
      );
    if (state.players[state.turnIndex]?.id !== me.id)
      return new Response(
        JSON.stringify({ success: false, error: "Not your turn" }),
        { status: 400 },
      );

    const card = body?.card;
    const chosenColor = norm(body?.chosenColor || "");
    const hand = state.hands[me.id] || [];
    const idx = hand.findIndex(
      (c) => c.color === card?.color && c.value === card?.value,
    );
    if (idx < 0)
      return new Response(
        JSON.stringify({ success: false, error: "Invalid card" }),
        { status: 400 },
      );

    const topCard = state.discardPile[state.discardPile.length - 1];
    if (!isPlayable(card, topCard, state.currentColor, hand)) {
      return new Response(
        JSON.stringify({ success: false, error: "Card not playable" }),
        { status: 400 },
      );
    }

    const value = norm(card.value);
    if (
      (value === "wild" || value === "wild draw four") &&
      !["red", "yellow", "green", "blue"].includes(chosenColor)
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Choose a color for wild card",
        }),
        { status: 400 },
      );
    }

    hand.splice(idx, 1);
    const payloadCard =
      value === "wild" || value === "wild draw four"
        ? { ...card, color: chosenColor }
        : card;
    applyCardEffect(state, me.id, payloadCard, chosenColor || card.color);
    scheduleAi(room);

    if (state.status === "finished") {
      await settleWinner(room, state.winnerId);
      room.started = false;
    }

    const data = serializeGameForUser(room, user.id);
    return Response.json({
      success: true,
      data,
      status: state.status,
      shouldReturnToLobby: state.status === "finished" || !data?.role,
    });
  }

  if (action === "draw-card") {
    const state = room.activeState;
    if (!state || state.status !== "active")
      return new Response(
        JSON.stringify({ success: false, error: "No active game" }),
        { status: 400 },
      );

    const me = state.players.find((p) => p.userId === user.id);
    if (!me)
      return new Response(
        JSON.stringify({ success: false, error: "Forbidden" }),
        { status: 403 },
      );
    if (state.players[state.turnIndex]?.id !== me.id)
      return new Response(
        JSON.stringify({ success: false, error: "Not your turn" }),
        { status: 400 },
      );

    drawFor(state, me.id, 1);
    const hand = state.hands[me.id] || [];
    const drawn = hand[hand.length - 1];
    const topCard = state.discardPile[state.discardPile.length - 1];

    if (!drawn || !isPlayable(drawn, topCard, state.currentColor, hand)) {
      advanceIndex(state, 1);
      scheduleAi(room);
    }

    if (state.status === "finished") {
      await settleWinner(room, state.winnerId);
      room.started = false;
    }

    const data = serializeGameForUser(room, user.id);
    return Response.json({
      success: true,
      data,
      status: state.status,
      shouldReturnToLobby: state.status === "finished" || !data?.role,
    });
  }

  if (action === "resign") {
    const state = room.activeState;
    if (!state || state.status !== "active")
      return new Response(
        JSON.stringify({ success: false, error: "No active game" }),
        { status: 400 },
      );

    const me = state.players.find((p) => p.userId === user.id);
    if (!me)
      return new Response(
        JSON.stringify({ success: false, error: "Forbidden" }),
        { status: 403 },
      );

    const leavingTurnIndex = state.players.findIndex((p) => p.id === me.id);
    const wasCurrentTurn = state.players[state.turnIndex]?.id === me.id;
    const remaining = state.players.filter((p) => p.id !== me.id);

    delete state.hands[me.id];
    state.players = remaining;
    room.players = room.players.filter((p) => p.userId !== user.id);

    if (room.hostUserId === user.id && room.players.length > 0) {
      const newHost =
        room.players.find((p) => p.type === "human") || room.players[0];
      room.hostUserId = newHost.userId;
      room.hostName = newHost.name;
      room.players = room.players.map((p) => ({
        ...p,
        isHost: p.userId === room.hostUserId,
      }));
    }

    if (state.players.length <= 1) {
      state.status = "finished";
      state.winnerId = state.players[0]?.id || null;
      await settleWinner(room, state.winnerId);
      room.started = false;
    } else {
      if (wasCurrentTurn) {
        const len = state.players.length;
        if (state.direction === 1) {
          state.turnIndex = leavingTurnIndex % len;
        } else {
          state.turnIndex = (((leavingTurnIndex - 1) % len) + len) % len;
        }
      } else if (leavingTurnIndex >= 0 && leavingTurnIndex < state.turnIndex) {
        state.turnIndex -= 1;
      }

      if (state.turnIndex < 0 || state.turnIndex >= state.players.length) {
        state.turnIndex = 0;
      }
      scheduleAi(room);
    }

    return Response.json({
      success: true,
      resigned: true,
      status: state.status,
      shouldReturnToLobby: true,
      room: { ...tableSummary(room), players: room.players },
    });
  }

  return new Response(
    JSON.stringify({ success: false, error: "Unknown action" }),
    { status: 400 },
  );
}
