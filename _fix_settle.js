const fs = require('fs');

let content = fs.readFileSync('src/app/casino/poker/multi/page.tsx', 'utf8');

// Fix 1: Add settle call in checkForWinner (first winner.id === myId block)
const old1 = `      if (winner.id === myId) {
        audioRef.current.playWin();
        setBalance((prev) => prev + pot);
        fetchUserTokens();
      } else {`;

const new1 = `      if (winner.id === myId) {
        audioRef.current.playWin();
        setBalance((prev) => prev + pot);
        fetchUserTokens();
        fetch("/api/poker/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winnerId: myId, amount: pot }),
        }).catch(() => {});
      } else {`;

// Fix 2: Add settle call in showdown (second winner.id === myId block)
const old2 = `    if (winner.id === myId) {
      audioRef.current.playWin();
      setBalance((prev) => prev + game.pot);
      fetchUserTokens();
      confetti({`;

const new2 = `    if (winner.id === myId) {
      audioRef.current.playWin();
      setBalance((prev) => prev + game.pot);
      fetchUserTokens();
      fetch("/api/poker/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerId: myId, amount: game.pot }),
      }).catch(() => {});
      confetti({`;

const c1 = (content.match(new RegExp(old1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
const c2 = (content.match(new RegExp(old2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
console.log(`Found ${c1} occurrences of checkForWinner block`);
console.log(`Found ${c2} occurrences of showdown block`);

if (content.includes(old1)) {
  content = content.replace(old1, new1);
  console.log('Applied fix 1 (checkForWinner)');
} else {
  console.log('WARNING: old1 not found!');
}

if (content.includes(old2)) {
  content = content.replace(old2, new2);
  console.log('Applied fix 2 (showdown)');
} else {
  console.log('WARNING: old2 not found!');
}

fs.writeFileSync('src/app/casino/poker/multi/page.tsx', content);
console.log('Done writing file');
