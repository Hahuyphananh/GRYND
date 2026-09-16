import { checkGameEnd, holdDice, nextTurn, rollDice, validateMove, TURN_TIME_LIMIT_MS, type DiceFlushCategory, type DiceFlushGameState } from "../../../game-engine/diceFlushEngine";

type SocketLike = { emit: (event: string, payload: any) => void; to?: (room: string) => { emit: (event:string, payload:any)=>void } };

const rooms = new Map<string, DiceFlushGameState>();

export function registerGame(name: string, handler: any) {
  return { name, handler };
}

const rakeRate = 0.05;

const OPEN_CATEGORIES = ["ones","twos","threes","fours","fives","sixes","threeOfKind","fourOfKind","fullHouse","smallStraight","largeStraight","fiveKind"] as DiceFlushCategory[];

// AI picks from the SHARED sheet — only categories nobody has claimed yet.
function pickAiCategory(state: DiceFlushGameState): DiceFlushCategory {
  const options = OPEN_CATEGORIES.filter((c) => state.scorecards[c] === undefined).map((category) => ({ category, score: require("../../../game-engine/diceFlushEngine").calculateScore(state.dice, category) }));
  options.sort((a,b)=>b.score-a.score);
  return options[Math.min(options.length - 1, Math.floor(Math.random() < 0.15 ? Math.random() * Math.min(options.length, 3) : 0))].category;
}

export function diceFlushHandler(socket: SocketLike, ctx: { userId: string; username: string; wallet: { lockWager: Function; payoutWinner: Function } }) {
  socket.emit("room_updated", { game: "yahtzee", rooms: [...rooms.values()] });

  return {
    create_room: ({ wager }: { wager: number }) => {
      const id = `yahtzee:${Date.now()}`;
      ctx.wallet.lockWager(ctx.userId, wager);
      const room: DiceFlushGameState = { id, game: "yahtzee", players: [{ userId: ctx.userId, name: ctx.username }], ai: false, wager, pot: wager, state: "waiting", currentTurn: ctx.userId, turnNumber: 1, rollsThisTurn: 0, dice: [1,1,1,1,1], heldDice:[false,false,false,false,false], scorecards: {}, scorecardOwner: {}, currentCall: null, turnDeadline: null };
      rooms.set(id, room);
      socket.emit("room_created", room);
    },
    join_room: ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room || room.state !== "waiting") return socket.emit("error", { message: "Room unavailable" });
      ctx.wallet.lockWager(ctx.userId, room.wager);
      const creatorId = room.players[0].userId;
      room.players.push({ userId: ctx.userId, name: ctx.username });
      room.state = "playing";
      // Shared sheet: random 50/50 starter, each player claims 6 categories.
      room.currentTurn = Math.random() < 0.5 ? creatorId : ctx.userId;
      room.turnDeadline = Date.now() + TURN_TIME_LIMIT_MS;
      room.pot += room.wager;
      socket.emit("room_updated", room);
      socket.emit("game_state_update", room);
    },
    start_ai_match: ({ wager, difficulty = "medium" }: { wager: number; difficulty?: "easy"|"medium"|"hard" }) => {
      const aiId = `ai:${difficulty}`;
      // AI mode is free play — skip `lockWager` (no token deduction) and
      // keep `pot` at 0 so the eventual match_ended payout can't credit
      // the AI or the human on game end (mirrors the HTTP route fix).
      // No shot clock vs AI — practice matches are untimed.
      const id = `yahtzee:${Date.now()}`;
      const room: DiceFlushGameState = { id, game: "yahtzee", players: [{ userId: ctx.userId, name: ctx.username }, { userId: aiId, name: `AI (${difficulty})`, isAI: true, difficulty }], ai: true, wager, pot: 0, state: "playing", currentTurn: Math.random() < 0.5 ? ctx.userId : aiId, turnNumber: 1, rollsThisTurn: 0, dice: [1,1,1,1,1], heldDice:[false,false,false,false,false], scorecards: {}, scorecardOwner: {}, currentCall: null, turnDeadline: null };
      rooms.set(id, room);
      socket.emit("room_created", room);
    },
    roll_dice: ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId); if (!room) return;
      try { validateMove(room, ctx.userId, "roll_dice"); const next = rollDice(room); rooms.set(roomId, next); socket.emit("game_state_update", next); } catch (e:any) { socket.emit("error", { message: e.message }); }
    },
    hold_dice: ({ roomId, heldDice }: { roomId: string; heldDice: boolean[] }) => {
      const room = rooms.get(roomId); if (!room) return;
      try { validateMove(room, ctx.userId, "hold_dice", { heldDice }); const next = holdDice(room, heldDice); rooms.set(roomId, next); socket.emit("game_state_update", next); } catch (e:any) { socket.emit("error", { message: e.message }); }
    },
    choose_category: ({ roomId, category }: { roomId: string; category: DiceFlushCategory }) => {
      const room = rooms.get(roomId); if (!room) return;
      try {
        validateMove(room, ctx.userId, "choose_category", { category });
        let next = nextTurn(room, ctx.userId, category);
        const ai = next.players.find(p=>p.isAI);
        if (ai && next.currentTurn === ai.userId) {
          let aiState = next;
          // Skill layer — the AI makes a random open category call too.
          if (aiState.currentCall === null) {
            const open = OPEN_CATEGORIES.filter((c) => aiState.scorecards[c] === undefined);
            if (open.length > 0) aiState.currentCall = open[Math.floor(Math.random() * open.length)];
          }
          for (let i=0;i<3;i++) aiState = rollDice(aiState);
          const aiCategory = pickAiCategory(aiState);
          next = nextTurn(aiState, ai.userId, aiCategory);
          socket.emit("ai_action", { roomId, action: "choose_category", category: aiCategory });
        }
        const ended = checkGameEnd(next);
        if (ended.ended) {
          // AI mode is free play — `pot` is 0 when started via
          // `start_ai_match`, so even on AI-mode match end there is no
          // payout to issue. PvP rooms still pay out normally.
          const payout = Math.max(0, Math.floor(next.pot * (1 - rakeRate)));
          if (payout > 0) {
            ctx.wallet.payoutWinner(ended.winnerId, payout, { roomId, game: "yahtzee" });
            socket.emit("payout_event", { roomId, winnerId: ended.winnerId, amount: payout, rake: next.pot - payout });
          }
          next.state = "finished";
          socket.emit("match_ended", { roomId, ...ended });
        }
        rooms.set(roomId, next);
        socket.emit("game_state_update", next);
      } catch (e:any) { socket.emit("error", { message: e.message }); }
    },
  };
}

export const diceFlushRegistration = registerGame("yahtzee", diceFlushHandler);
