import { checkGameEnd, holdDice, nextTurn, rollDice, validateMove, type YahtzeeCategory, type YahtzeeGameState } from "../../../game-engine/yahtzeeEngine";

type SocketLike = { emit: (event: string, payload: any) => void; to?: (room: string) => { emit: (event:string, payload:any)=>void } };

const rooms = new Map<string, YahtzeeGameState>();

export function registerGame(name: string, handler: any) {
  return { name, handler };
}

const rakeRate = 0.05;

function pickAiCategory(state: YahtzeeGameState, aiId: string): YahtzeeCategory {
  const used = state.scorecards[aiId] ?? {};
  const open = ["ones","twos","threes","fours","fives","sixes","threeOfKind","fourOfKind","fullHouse","smallStraight","largeStraight","yahtzee","chance"] as YahtzeeCategory[];
  const options = open.filter((c) => used[c] === undefined).map((category) => ({ category, score: require("../../../game-engine/yahtzeeEngine").calculateScore(state.dice, category) }));
  options.sort((a,b)=>b.score-a.score);
  return options[Math.min(options.length - 1, Math.floor(Math.random() < 0.15 ? Math.random() * Math.min(options.length, 3) : 0))].category;
}

export function yahtzeeHandler(socket: SocketLike, ctx: { userId: string; username: string; wallet: { lockWager: Function; payoutWinner: Function } }) {
  socket.emit("room_updated", { game: "yahtzee", rooms: [...rooms.values()] });

  return {
    create_room: ({ wager }: { wager: number }) => {
      const id = `yahtzee:${Date.now()}`;
      ctx.wallet.lockWager(ctx.userId, wager);
      const room: YahtzeeGameState = { id, game: "yahtzee", players: [{ userId: ctx.userId, name: ctx.username }], ai: false, wager, pot: wager, state: "waiting", currentTurn: ctx.userId, turnNumber: 1, rollsThisTurn: 0, dice: [1,1,1,1,1], heldDice:[false,false,false,false,false], scorecards: { [ctx.userId]: {} } };
      rooms.set(id, room);
      socket.emit("room_created", room);
    },
    join_room: ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room || room.state !== "waiting") return socket.emit("error", { message: "Room unavailable" });
      ctx.wallet.lockWager(ctx.userId, room.wager);
      room.players.push({ userId: ctx.userId, name: ctx.username });
      room.scorecards[ctx.userId] = {};
      room.state = "playing";
      room.pot += room.wager;
      socket.emit("room_updated", room);
      socket.emit("game_state_update", room);
    },
    start_ai_match: ({ wager, difficulty = "medium" }: { wager: number; difficulty?: "easy"|"medium"|"hard" }) => {
      const aiId = `ai:${difficulty}`;
      ctx.wallet.lockWager(ctx.userId, wager);
      const id = `yahtzee:${Date.now()}`;
      const room: YahtzeeGameState = { id, game: "yahtzee", players: [{ userId: ctx.userId, name: ctx.username }, { userId: aiId, name: `AI (${difficulty})`, isAI: true, difficulty }], ai: true, wager, pot: wager * 2, state: "playing", currentTurn: ctx.userId, turnNumber: 1, rollsThisTurn: 0, dice: [1,1,1,1,1], heldDice:[false,false,false,false,false], scorecards: { [ctx.userId]: {}, [aiId]: {} } };
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
    choose_category: ({ roomId, category }: { roomId: string; category: YahtzeeCategory }) => {
      const room = rooms.get(roomId); if (!room) return;
      try {
        validateMove(room, ctx.userId, "choose_category", { category });
        let next = nextTurn(room, ctx.userId, category);
        const ai = next.players.find(p=>p.isAI);
        if (ai && next.currentTurn === ai.userId) {
          let aiState = next;
          for (let i=0;i<3;i++) aiState = rollDice(aiState);
          const aiCategory = pickAiCategory(aiState, ai.userId);
          next = nextTurn(aiState, ai.userId, aiCategory);
          socket.emit("ai_action", { roomId, action: "choose_category", category: aiCategory });
        }
        const ended = checkGameEnd(next);
        if (ended.ended) {
          const payout = Math.floor(next.pot * (1 - rakeRate));
          ctx.wallet.payoutWinner(ended.winnerId, payout, { roomId, game: "yahtzee" });
          next.state = "finished";
          socket.emit("payout_event", { roomId, winnerId: ended.winnerId, amount: payout, rake: next.pot - payout });
          socket.emit("match_ended", { roomId, ...ended });
        }
        rooms.set(roomId, next);
        socket.emit("game_state_update", next);
      } catch (e:any) { socket.emit("error", { message: e.message }); }
    },
  };
}

export const yahtzeeRegistration = registerGame("yahtzee", yahtzeeHandler);
