const fs = require('fs');
let content = fs.readFileSync('src/app/casino/poker/multi/page.tsx', 'utf8');

// Add tableStack blind deductions in startGame
// Insert setTableStack after the blind deductions on players array
const oldBlinds = `    players[sbIndex].stack -= game.smallBlind;
    players[sbIndex].currentBet = game.smallBlind;
    players[sbIndex].lastAction = "Small Blind";

    players[bbIndex].stack -= game.bigBlind;
    players[bbIndex].currentBet = game.bigBlind;
    players[bbIndex].lastAction = "Big Blind";`;

const newBlinds = `    players[sbIndex].stack -= game.smallBlind;
    players[sbIndex].currentBet = game.smallBlind;
    players[sbIndex].lastAction = "Small Blind";

    players[bbIndex].stack -= game.bigBlind;
    players[bbIndex].currentBet = game.bigBlind;
    players[bbIndex].lastAction = "Big Blind";

    // Sync tableStack with blind deductions
    if (players[sbIndex].id === myId) setTableStack((prev) => prev - game.smallBlind);
    if (players[bbIndex].id === myId) setTableStack((prev) => prev - game.bigBlind);`;

if (content.includes(oldBlinds)) {
  content = content.replace(oldBlinds, newBlinds);
  console.log('Added tableStack blind deductions to startGame');
} else {
  console.log('FAIL: blind deduction pattern not found');
  process.exit(1);
}

fs.writeFileSync('src/app/casino/poker/multi/page.tsx', content);
console.log('Done');
