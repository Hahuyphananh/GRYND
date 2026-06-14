const fs = require('fs');

let content = fs.readFileSync('src/app/casino/poker/multi/page.tsx', 'utf8');

// Fix 1: Update the Return button to pass stack when cashing out
const oldReturn = `          onClick={async () => {
            if (game?.stage === \"showdown\" || game?.waiting) {
              await leaveCurrentGame();
              setGame(null);`;

const newReturn = `          onClick={async () => {
            if (game?.stage === \"showdown\" || game?.waiting) {
              const meStack = game?.players.find((p) => p.id === myId)?.stack ?? 0;
              await leaveCurrentGame(meStack);
              await fetchUserTokens();
              setGame(null);`;

if (content.includes(oldReturn)) {
  content = content.replace(oldReturn, newReturn);
  console.log('Applied fix 1: Return button now passes stack');
} else {
  console.log('WARNING: Return button pattern not found!');
}

// Fix 2: Add Cash Out button next to the invite code area (after the replay button, before closing the div)
const oldReplayBtn = `          {game?.replayVisible && (
            <button
              onClick={replayHand}
              className=\"bg-gradient-to-r from-[#ff00cc]/60 to-[#ff00cc]/60 border border-[#ff00cc]/50 text-white px-5 py-2 rounded font-bold hover:from-[#ff00cc] hover:to-[#ff00cc] transition shadow-[0_0_15px_rgba(255,0,204,0.4)]\"
            >
              🔄 Replay Hand
            </button>
          )}`;

const newReplayWithCashout = `          {game?.replayVisible && (
            <button
              onClick={replayHand}
              className=\"bg-gradient-to-r from-[#ff00cc]/60 to-[#ff00cc]/60 border border-[#ff00cc]/50 text-white px-5 py-2 rounded font-bold hover:from-[#ff00cc] hover:to-[#ff00cc] transition shadow-[0_0_15px_rgba(255,0,204,0.4)]\"
            >
              🔄 Replay Hand
            </button>
          )}

          {/* CASH OUT button */}
          {(game?.stage === \"showdown\" || game?.waiting) && me && me.stack > 0 && (
            <button
              onClick={async () => {
                const cs = me.stack;
                await leaveCurrentGame(cs);
                await fetchUserTokens();
                setGame(null);
              }}
              className=\"bg-gradient-to-r from-[#FFD700]/70 to-[#FFA500]/70 border border-[#FFD700]/50 text-black px-5 py-2 rounded font-bold hover:from-[#FFD700] hover:to-[#FFA500] transition shadow-[0_0_15px_rgba(255,215,0,0.4)]\"
            >
              💰 Retirer {me.stack} jetons
            </button>
          )}`;

if (content.includes(oldReplayBtn)) {
  content = content.replace(oldReplayBtn, newReplayWithCashout);
  console.log('Applied fix 2: Added Cash Out button');
} else {
  console.log('WARNING: Replay button pattern not found!');
}

fs.writeFileSync('src/app/casino/poker/multi/page.tsx', content);
console.log('Done writing file');
