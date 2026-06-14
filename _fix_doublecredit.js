const fs = require('fs');

let content = fs.readFileSync('src/app/casino/poker/multi/page.tsx', 'utf8');

// Fix 1: Remove settle call from checkForWinner
const old1 = `        fetchUserTokens();
        fetch("/api/poker/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winnerId: myId, amount: pot }),
        }).catch(() => {});
      } else {`;

const new1 = `        fetchUserTokens();
      } else {`;

if (content.includes(old1)) {
  content = content.replace(old1, new1);
  console.log('Applied fix 1: Removed settle from checkForWinner');
} else {
  console.log('WARNING: checkForWinner settle block not found!');
}

// Fix 2: Remove settle call from showdown
const old2 = `        fetchUserTokens();
      fetch("/api/poker/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerId: myId, amount: game.pot }),
      }).catch(() => {});
      confetti({`;

const new2 = `        fetchUserTokens();
      confetti({`;

if (content.includes(old2)) {
  content = content.replace(old2, new2);
  console.log('Applied fix 2: Removed settle from showdown');
} else {
  console.log('WARNING: showdown settle block not found!');
}

fs.writeFileSync('src/app/casino/poker/multi/page.tsx', content);
console.log('Done writing file');
