const fs = require('fs');

let content = fs.readFileSync('src/app/casino/poker/multi/page.tsx', 'utf8');

// Find and remove the settle call from showdown
// The exact block is:
//       fetch("/api/poker/settle", {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ winnerId: myId, amount: game.pot }),
//       }).catch(() => {});
//       confetti({

const searchStr = `      fetch("/api/poker/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerId: myId, amount: game.pot }),
      }).catch(() => {});
      confetti({`;

const replaceStr = `      confetti({`;

const count = (content.match(/poker\/settle/g) || []).length;
console.log(`Found ${count} remaining settle references`);

if (content.includes(searchStr)) {
  content = content.replace(searchStr, replaceStr);
  console.log('Removed settle call from showdown');
} else {
  console.log('Search string not found, trying alternative...');
  // Try with different whitespace
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('poker/settle')) {
      console.log(`Found at line ${i + 1}: ${lines[i].trim()}`);
      // Print context
      console.log(`  ${i}: ${lines[i-1]?.trim() || ''}`);
      console.log(`  ${i+1}: ${lines[i+1]?.trim() || ''}`);
      console.log(`  ${i+2}: ${lines[i+2]?.trim() || ''}`);
      console.log(`  ${i+3}: ${lines[i+3]?.trim() || ''}`);
      console.log(`  ${i+4}: ${lines[i+4]?.trim() || ''}`);
      console.log(`  ${i+5}: ${lines[i+5]?.trim() || ''}`);
    }
  }
}

// Also remove the settle route file
try {
  fs.unlinkSync('src/app/api/poker/settle/route.ts');
  console.log('Deleted dead settle route');
} catch(e) {}

fs.writeFileSync('src/app/casino/poker/multi/page.tsx', content);
console.log('Done');
