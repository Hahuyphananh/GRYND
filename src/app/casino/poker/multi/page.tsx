"use client";

import { useState, useEffect } from "react";
import { Card, evaluateHand } from "../../../lib/handEval";

type Player = {
  id: string;
  name: string;
  stack: number;
  hand: Card[];
  isAI?: boolean;
  hasFolded?: boolean;
  lastAction?: string;
  currentBet: number;
};

type Game = {
  players: Player[];
  community: Card[];
  deck: Card[];
  pot: number;
  currentTurn: number;
  roundStarter?: number;
  stage: "pre-flop" | "flop" | "turn" | "river" | "showdown";
  smallBlind: number;
  bigBlind: number;
  winnerId?: string;
  replayVisible: boolean;
  dealerIndex: number;
  inviteCode?: string;
};

const SUITS = ["♠", "♥", "♦", "♣"];
const VALUES = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

function createDeck(): Card[] {
  return SUITS.flatMap(suit => VALUES.map(value => ({ suit, value })));
}
function shuffle(deck: Card[]): Card[] {
  return deck.sort(()=>Math.random()-0.5);
}

function nextActive(start: number, players: Player[]): number {
  let i = start;
  let safety = 0;
  while (players[i].hasFolded && safety < players.length) {
    i = (i + 1) % players.length;
    safety++;
  }
  return i;
}

export default function PokerPage() {
  const [name,setName]=useState("");
  const [tempName,setTempName]=useState("");
  const [game,setGame]=useState<Game|null>(null);
  const [aiCount,setAiCount]=useState(2);
  const [raiseAmount,setRaiseAmount] = useState(50);
  const [balance, setBalance] = useState<number>(0); // ✅ player balance synced
  const [inviteCode, setInviteCode] = useState("");
const [joiningGame, setJoiningGame] = useState(false);


  const maxCurrentBet = (players: Player[]) => Math.max(...players.map(p => p.currentBet || 0));

  const fetchUserTokens = async () => {
  try {
    const res = await fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    const data = await res.json();
    if (data.success) {
      setBalance(parseFloat(data.data.balance));
    } else {
      console.error("Failed to fetch tokens:", data.error);
    }
  } catch (err) {
    console.error("Error fetching tokens:", err);
  }
};


  // ✅ fetch tokens from existing API
  useEffect(() => {
  fetchUserTokens();
}, []);


  // ======== Create Game =========
  async function createGame(dealerIndex = 0) {
  if (!name.trim()) return alert("Enter your name first");

  const deck = shuffle(createDeck());
  const players: Player[] = [{ id: "player", name, stack: 1000, hand: [], currentBet: 0 }];

  for (let i = 0; i < aiCount; i++) {
    players.push({ id: `ai${i}`, name: `AI ${i + 1}`, stack: 1000, hand: [], isAI: true, currentBet: 0 });
  }

  const sb = 10, bb = 20;
  const sbIndex = (dealerIndex + 1) % players.length;
  const bbIndex = (dealerIndex + 2) % players.length;

  players.forEach(p => { p.hand = []; p.hasFolded = false; p.lastAction = ""; p.currentBet = 0; });
  players[sbIndex].stack -= sb; players[sbIndex].currentBet = sb; players[sbIndex].lastAction = "Small Blind";
  players[bbIndex].stack -= bb; players[bbIndex].currentBet = bb; players[bbIndex].lastAction = "Big Blind";

  const firstToAct = (bbIndex + 1) % players.length;

  // ✅ Call backend
  try {
    const res = await fetch("/api/poker/create-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxPlayers: aiCount + 1, isPrivate: false }),
    });

    if (!res.ok) return alert("Failed to create game on server");
    const data = await res.json();

    setGame({
      players,
      community: [],
      deck,
      pot: sb + bb,
      currentTurn: firstToAct,
      roundStarter: firstToAct,
      stage: "pre-flop",
      smallBlind: sb,
      bigBlind: bb,
      replayVisible: false,
      dealerIndex,
      inviteCode: data.inviteCode,
    });

    dealHoleCards(players, deck);

  } catch (err) {
    console.error("Error creating game:", err);
    alert("Error creating game. Check console.");
  }
}

// Deals two cards to each player from the deck
function dealHoleCards(players: Player[], deck: Card[]) {
  for (let i = 0; i < players.length; i++) {
    players[i].hand = [deck.pop()!, deck.pop()!];
  }
}
// ======== JOIN GAME =========
async function joinGame() {
  if (!inviteCode.trim()) return alert("Enter invite code!");

  setJoiningGame(true);

  try {
    const res = await fetch(`/api/poker/join?code=${inviteCode.trim()}`);
    if (!res.ok) {
      const err = await res.json();
      return alert(err?.error || "Failed to join game");
    }

    const data = await res.json();
    const serverGame = data.game as Game;

    // Add the local player (you) + optional AI if needed
    const players: Player[] = [serverGame.players[0]]; // the joined player

    // Optionally add AI players if you want consistent AI count
    for (let i = 0; i < aiCount; i++) {
      players.push({
        id: `ai${i}`,
        name: `AI ${i + 1}`,
        stack: 1000,
        hand: [],
        isAI: true,
        currentBet: 0,
      });
    }

    // Initialize game state
    const deck = shuffle(createDeck());
    dealHoleCards(players, deck);

    const sb = 10, bb = 20;
    const dealerIndex = 0;
    const sbIndex = (dealerIndex + 1) % players.length;
    const bbIndex = (dealerIndex + 2) % players.length;

    players[sbIndex].stack -= sb; players[sbIndex].currentBet = sb; players[sbIndex].lastAction = "Small Blind";
    players[bbIndex].stack -= bb; players[bbIndex].currentBet = bb; players[bbIndex].lastAction = "Big Blind";

    const firstToAct = (bbIndex + 1) % players.length;

    setGame({
      players,
      community: [],
      deck,
      pot: sb + bb,
      currentTurn: firstToAct,
      roundStarter: firstToAct,
      stage: "pre-flop",
      smallBlind: sb,
      bigBlind: bb,
      replayVisible: false,
      dealerIndex,
      inviteCode: serverGame.inviteCode,
    });

    setJoiningGame(false);
  } catch (err) {
    console.error("Join game error:", err);
    alert("Failed to join game. See console.");
    setJoiningGame(false);
  }
}


  // ======== AI Turn Logic =======
  useEffect(() => {
    if(!game) return;
    if (game.stage === "showdown") return;

    const current = game.players[game.currentTurn];
    if (!current || current.hasFolded) return;

    if (current.isAI) {
      const hs = evaluateHand(current.hand, game.community);
      let action: "check"|"call"|"raise"|"fold" = "check";

      if (hs.includes("Three") || hs.includes("Straight") || hs.includes("Flush")) action = "raise";
      else if (hs.includes("Pair") || hs.includes("Two Pair")) action = "call";
      else if (Math.random()<0.2) action="fold";
      else action="call";

      const t = setTimeout(()=>performAction(action,true),800+Math.random()*500);
      return ()=>clearTimeout(t);
    }
  }, [game?.currentTurn, game?.stage]);

  // ======== Actions =========
  function performAction(action: "check" | "call" | "raise" | "fold", isAI = false) {
    if (!game) return;

    const players = game.players.map(p => ({ ...p }));
    const currentIndex = game.currentTurn;
    const current = players[currentIndex];
    if (!current || current.hasFolded) return;

    const highest = maxCurrentBet(players);
    let potNew = game.pot;

    if (action === "fold") {
      current.hasFolded = true;
      current.lastAction = "Folded";
    } else if (action === "call") {
      const toCall = Math.max(0, highest - (current.currentBet || 0));
      if (toCall > 0) {
        const actual = Math.min(toCall, current.stack);
        current.stack -= actual;
        current.currentBet += actual;
        potNew += actual;
        current.lastAction = `Called ${actual}`;

        if (current.id === "player") {
          setBalance(prev => Math.max(prev - actual, 0)); // ✅ deduct from DB balance
          fetchUserTokens(); // ✅ refresh after action
        }
      } else {
        current.lastAction = "Check";
      }
    } else if (action === "raise") {
      const toCall = Math.max(0, highest - (current.currentBet || 0));
      const totalPut = toCall + raiseAmount;
      const actual = Math.min(totalPut, current.stack);
      current.stack -= actual;
      current.currentBet += actual;
      potNew += actual;
      current.lastAction = `Raised ${raiseAmount}`;

      if (current.id === "player") {
        setBalance(prev => Math.max(prev - actual, 0)); // ✅ deduct on raise
      }
    }

    let next = nextActive((currentIndex + 1) % players.length, players);
    const wrappedBack = next === game.roundStarter;

    if (wrappedBack) {
      setGame(g => g ? { ...g, players, pot: potNew } : g);
      advanceStage();
    } else {
      setGame(g => g ? { ...g, players, pot: potNew, currentTurn: next } : g);
    }
  }

  async function advanceStage() {
    if (!game) return;
    const deck = [...game.deck];
    const comm = [...game.community];
    const playersReset = game.players.map(p => ({ ...p, currentBet: 0 }));

    let nextStage: Game["stage"] = game.stage;

    if (game.stage === "pre-flop") {
      for (let i = 0; i < 3; i++) {
        await new Promise(res => setTimeout(res, 500));
        comm.push(deck.pop()!);
      }
      nextStage = "flop";
    } else if (game.stage === "flop") {
      await new Promise(res => setTimeout(res, 500));
      comm.push(deck.pop()!);
      nextStage = "turn";
    } else if (game.stage === "turn") {
      await new Promise(res => setTimeout(res, 500));
      comm.push(deck.pop()!);
      nextStage = "river";
    } else if (game.stage === "river") {
      showdown();
      return;
    }

    const playerIndex = playersReset.findIndex(p => p.id === "player");

    setGame({
      ...game,
      deck,
      community: comm,
      stage: nextStage,
      players: playersReset,
      currentTurn: playerIndex,
    });
  }

  function showdown() {
    if(!game) return;
    const active=game.players.filter(p=>!p.hasFolded);
    let winner=active[0], best=-1;
    active.forEach(p=>{
      const label=evaluateHand(p.hand,game.community);
      let score=1;
      if(label.includes("Royal")) score=10;
      else if(label.includes("Straight Flush")) score=9;
      else if(label.includes("Four")) score=8;
      else if(label.includes("Full")) score=7;
      else if(label.includes("Flush")) score=6;
      else if(label.includes("Straight")) score=5;
      else if(label.includes("Three")) score=4;
      else if(label.includes("Two Pair")) score=3;
      else if(label.includes("Pair")) score=2;
      if(score>best){best=score;winner=p;}
    });

    const updated=game.players.map(p=>p.id===winner.id?{...p,stack:p.stack+game.pot}:p);

    // ✅ add winnings back to balance if player wins
    if (winner.id === "player") {
      setBalance(prev => prev + game.pot);
      fetchUserTokens(); // ✅ refresh after showdown
    }

    setGame({...game,players:updated,winnerId:winner.id,pot:0,stage:"showdown",replayVisible:true});
  }

  function replayHand() {
    if(!game) return;
    const nextDealer=(game.dealerIndex+1)%game.players.length;
    createGame(nextDealer);
  }

  // ======== RENDER ========
  if(!name){
    return(
      <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white">
        <div className="p-8 bg-slate-800 rounded shadow w-96 text-center">
          <h1 className="text-2xl font-bold mb-4">Enter your name</h1>
          <form onSubmit={e=>{e.preventDefault();if(tempName.trim())setName(tempName.trim());}}>
            <input className="border p-2 w-full rounded mb-4 text-black" value={tempName} onChange={e=>setTempName(e.target.value)}/>
            <button className="bg-green-500 px-4 py-2 rounded w-full font-bold">Enter</button>
          </form>
        </div>
      </div>
    );
  }
  

if (!game) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white">
      <div className="p-6 bg-slate-800 rounded shadow w-96 text-center mb-4">
        <h1 className="text-2xl mb-4">{joiningGame ? "Join Game" : "Create Game"}</h1>
        <div className="mb-2">Balance: {balance}</div>

{!joiningGame ? (
  <>
    <label className="block mb-2">Number of AI players:</label>
    <input
      type="number"
      min={0}
      max={5}
      value={aiCount}
      onChange={(e) => setAiCount(Number(e.target.value))}
      className="border p-2 rounded mb-4 w-full text-black"
    />
    <button
      onClick={() => createGame()}
      className="bg-yellow-500 px-4 py-2 rounded w-full font-bold mb-2"
    >
      Create Game
    </button>

    <button
      onClick={() => setJoiningGame(true)} // ✅ toggle to join form
      className="bg-green-500 px-4 py-2 rounded w-full font-bold mb-2"
    >
      Join Game
    </button>
  </>
) : (
  <>
    <input
      placeholder="Enter Invite Code"
      value={inviteCode}
      onChange={(e) => setInviteCode(e.target.value)}
      className="border p-2 w-full rounded mb-4 text-black"
    />

    <button
      onClick={async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text.trim()) setInviteCode(text.trim());
        } catch {
          alert("Unable to access clipboard.");
        }
      }}
      className="bg-yellow-400 px-3 py-1 rounded w-full font-bold mb-2 text-black"
    >
      Paste from Clipboard
    </button>

    <button
      onClick={joinGame} // ✅ uses your joinGame function
      className="bg-green-500 px-4 py-2 rounded w-full font-bold mb-2"
    >
      Join Game
    </button>

    <button
      onClick={() => setJoiningGame(false)} // ✅ back to initial panel
      className="bg-gray-500 px-4 py-2 rounded w-full font-bold"
    >
      Back
    </button>
  </>
)}

      </div>
    </div>
  );
}


  const centerX=350, centerY=200, rx=280, ry=140;
  const totalPlayers=game.players.length;
  const aiCountReal=totalPlayers-1;

  return(
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white p-6">
      <h1 className="text-3xl mb-4">Texas Hold'em</h1>
{game.inviteCode && (
  <div className="mb-4 text-center">
    <span className="font-bold">Invite Code:</span>{" "}
    <span className="bg-yellow-300 text-black px-2 py-1 rounded">{game.inviteCode}</span>
    <button
      onClick={() => {
        navigator.clipboard.writeText(game.inviteCode || "");
        alert("Invite code copied!");
      }}
      className="ml-2 bg-blue-500 px-3 py-1 rounded text-sm"
    >
      Copy
    </button>
  </div>
)}

      <div className="mb-2 font-bold">Balance: {balance}</div>
      <div className="relative w-[700px] h-[400px] bg-green-700 rounded-full border-8 border-yellow-800 flex items-center justify-center mb-6">
        {/* Pot + Community */}
        <div className="absolute top-[45%] left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex flex-col items-center">
          <div className="mb-2 font-bold">Pot: {game.pot}</div>
          <div className="flex gap-2">
            {game.community.map((c,i)=>(
            <div
  key={i}
  className={`w-16 h-24 bg-white flex items-center justify-center rounded shadow 
  ${c.suit === "♥" || c.suit === "♦" ? "text-red-600" : "text-black"}`}
>
  {c.value}{c.suit}
</div>

            ))}
          </div>
        </div>

        {/* Players */}
        {game.players.map((p,idx)=>{
          let left=centerX,top=centerY;
          if(p.id==="player"){ left=centerX; top=centerY+ry-20; }
          else{
            const aiIndex=idx-1;
            const angle=-Math.PI/2+(aiIndex+0.5)*(2*Math.PI/aiCountReal);
            const x=Math.cos(angle)*rx, y=Math.sin(angle)*ry;
            left=centerX+x; top=centerY+y-10;
          }
          return(
            <div key={p.id}
              className={`absolute w-32 p-2 rounded text-center ${p.id==="player"?"bg-yellow-500 text-black":"bg-slate-700"} 
              ${p.hasFolded?"opacity-50":""} ${game.winnerId===p.id?"border-2 border-yellow-400":""}`}
              style={{left,top,transform:"translate(-50%,-50%)"}}
            >
              <div className="font-semibold">{p.name}</div>
              <div className="text-sm">Stack: {p.stack}</div>
              {p.currentBet>0 && (
                <div className="mt-2 flex justify-center">
                  <div className="w-10 h-10 bg-red-600 rounded-full flex items-center justify-center text-white font-bold">{p.currentBet}</div>
                </div>
              )}
              <div className="mt-2 flex justify-center gap-1">
                {p.id==="player"
                  ? p.hand.map((c,i)=><div
  key={i}
  className={`px-1 py-0.5 border rounded bg-white 
  ${c.suit === "♥" || c.suit === "♦" ? "text-red-600" : "text-black"}`}
>
  {c.value}{c.suit}
</div>
)
                  : game.stage!=="showdown"
                    ? (<><div className="w-12 h-16 bg-gray-800 rounded"></div><div className="w-12 h-16 bg-gray-800 rounded"></div></>)
                    : p.hand.map((c,i)=><div
  key={i}
  className={`px-1 py-0.5 border rounded bg-white 
  ${c.suit === "♥" || c.suit === "♦" ? "text-red-600" : "text-black"}`}
>
  {c.value}{c.suit}
</div>
)
                }
              </div>
              {p.lastAction && <div className="text-xs mt-1 italic">{p.lastAction}</div>}
            </div>
          );
        })}
      </div>

      <div className="mb-4">Your Best Hand: {evaluateHand(game.players.find(p=>p.id==="player")!.hand, game.community)}</div>

      {game.stage!=="showdown" && (
        <div className="flex gap-2 mb-4 items-center">
          <button onClick={()=>performAction("fold")} className="bg-red-600 px-4 py-2 rounded">Fold</button>
          <button onClick={()=>performAction("check")} className="bg-yellow-500 px-4 py-2 rounded text-black">Check</button>
          <button onClick={()=>performAction("call")} className="bg-blue-600 px-4 py-2 rounded">Call</button>
          <input type="number" min={10} max={game.players[0].stack} value={raiseAmount} onChange={e=>setRaiseAmount(Number(e.target.value))} className="w-20 text-black px-2 py-1 rounded"/>
          <button onClick={()=>performAction("raise")} className="bg-green-600 px-4 py-2 rounded">Raise</button>
        </div>
      )}

      {game.replayVisible && <button onClick={replayHand} className="bg-purple-600 px-6 py-2 rounded font-bold">Replay Hand</button>}
    </div>
  );
}
