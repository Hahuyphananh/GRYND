const fs = require('fs');
let content = fs.readFileSync('src/app/casino/poker/multi/page.tsx', 'utf8');
let changed = 0;

// 1. Rename state declaration: balance -> tokenBalance, add tableStack
const oldState = `  const [balance, setBalance] = useState<number>(0);`;
const newState = `  const [tokenBalance, setTokenBalance] = useState<number>(0);
  const [tableStack, setTableStack] = useState<number>(0);`;
if (content.includes(oldState)) {
  content = content.replace(oldState, newState);
  changed++; console.log('1. Replaced balance state with tokenBalance + tableStack');
} else { console.log('FAIL 1'); process.exit(1); }

// 2. fetchUserTokens: setBalance -> setTokenBalance
const oldFetch = `        setBalance(parseFloat(data.data.balance));`;
const newFetch = `        setTokenBalance(parseFloat(data.data.balance));`;
if (content.includes(oldFetch)) {
  content = content.replace(oldFetch, newFetch);
  changed++; console.log('2. fetchUserTokens -> setTokenBalance');
} else { console.log('FAIL 2'); process.exit(1); }

// 3. joinGame: setBalance -> setTableStack (it's table stack, not token balance)
const oldJoin = `      if (me) setBalance(me.stack);`;
const newJoin = `      if (me) setTableStack(me.stack);`;
if (content.includes(oldJoin)) {
  content = content.replace(oldJoin, newJoin);
  changed++; console.log('3. joinGame -> setTableStack');
} else { console.log('FAIL 3'); process.exit(1); }

// 4. checkForWinner: setBalance -> setTableStack
const oldCFW = `        setBalance((prev) => prev + pot);`;
const newCFW = `        setTableStack((prev) => prev + pot);`;
const c1 = (content.match(/setBalance\(\(prev\) => prev \+ pot\)/g) || []).length;
if (c1 === 1) {
  content = content.replace(oldCFW, newCFW);
  changed++; console.log('4. checkForWinner -> setTableStack');
} else { console.log(`WARN 4: found ${c1} matches for checkForWinner pattern`); }

// 5. showdown: setBalance -> setTableStack
const oldSD = `      setBalance((prev) => prev + game.pot);`;
const newSD = `      setTableStack((prev) => prev + game.pot);`;
const c2 = (content.match(/setBalance\(\(prev\) => prev \+ game\.pot\)/g) || []).length;
if (c2 === 1) {
  content = content.replace(oldSD, newSD);
  changed++; console.log('5. showdown -> setTableStack');
} else { console.log(`WARN 5: found ${c2} matches for showdown pattern`); }

// 6. performAction: all setBalance deductions -> setTableStack
const oldPA = /setBalance\(\(prev\) => Math\.max\(prev - actual, 0\)\)/g;
const newPA = 'setTableStack((prev) => Math.max(prev - actual, 0))';
const paCount = (content.match(oldPA) || []).length;
content = content.replace(oldPA, newPA);
changed++; console.log(`6. performAction: ${paCount} setBalance -> setTableStack replacements`);

// 7. openBuyInPopup: balance -> tokenBalance
const oldOpen = `    const defaultBuyIn = Math.min(100, balance || 100);`;
const newOpen = `    const defaultBuyIn = Math.min(100, tokenBalance || 100);`;
if (content.includes(oldOpen)) {
  content = content.replace(oldOpen, newOpen);
  changed++; console.log('7. openBuyInPopup -> tokenBalance');
} else { console.log('FAIL 7'); process.exit(1); }

// 8. confirmBuyIn: balance -> tokenBalance checks
const oldCheck = `    if (buyInAmount > balance) return alert("Insufficient balance for this buy-in");`;
const newCheck = `    if (buyInAmount > tokenBalance) return alert("Insufficient balance for this buy-in");`;
if (content.includes(oldCheck)) {
  content = content.replace(oldCheck, newCheck);
  changed++; console.log('8. confirmBuyIn check -> tokenBalance');
} else { console.log('FAIL 8'); process.exit(1); }

// 9. Buy-in popup UI: all balance references -> tokenBalance
// Line ~2277: {balance.toLocaleString()} jetons
content = content.replace(/\{balance\.toLocaleString\(\)\} jetons/g, '{tokenBalance.toLocaleString()} jetons');
// Line ~2291: max={balance}
content = content.replace('max={balance}', 'max={tokenBalance}');
// Line ~2305: v <= balance ?
content = content.replace(/v <= balance \?/g, 'v <= tokenBalance ?');
// Line ~2322: Math.floor(balance / 2)
content = content.replace(/Math\.max\(10, Math\.floor\(balance \/ 2\)\)/g, 'Math.max(10, Math.floor(tokenBalance / 2))');
// Line ~2328: setBuyInAmount(balance)
content = content.replace(/onClick=\{\(\) => setBuyInAmount\(balance\)\}/g, 'onClick={() => setBuyInAmount(tokenBalance)}');
// Line ~2345: buyInAmount > balance
content = content.replace(/buyInAmount < 10 \|\| buyInAmount > balance/g, 'buyInAmount < 10 || buyInAmount > tokenBalance');
// Line ~2347: buyInAmount <= balance
content = content.replace(/buyInAmount >= 10 && buyInAmount <= balance/g, 'buyInAmount >= 10 && buyInAmount <= tokenBalance');
changed++; console.log('9. Buy-in popup UI: balance -> tokenBalance');

// 10. confirmBuyIn: set tokenBalance after buy-in (deduct locally), set tableStack
const oldConfirmEnd = `    // Fetch latest game state and token balance from DB
    await fetchGameState(game.inviteCode!);
    await fetchUserTokens();
    setShowBuyInPopup(false);
    setSeatModalOpen(false);
    setSelectedSeat(null);`;
const newConfirmEnd = `    // Set table stack from buy-in amount, fetch latest from DB
    setTableStack(buyInAmount);
    await fetchGameState(game.inviteCode!);
    await fetchUserTokens();
    setShowBuyInPopup(false);
    setSeatModalOpen(false);
    setSelectedSeat(null);`;
if (content.includes(oldConfirmEnd)) {
  content = content.replace(oldConfirmEnd, newConfirmEnd);
  changed++; console.log('10. confirmBuyIn sets tableStack');
} else { console.log('FAIL 10'); process.exit(1); }

// 11. Cash Out button: use me.stack (tableStack reflects it)
// Leave as-is, it uses me.stack which is correct

// 12. Return button: use meStack from game state
// Leave as-is, it's correct

// 13. Add leave-after-hand checkbox UI next to invite code
// Insert after the Cash Out button block, before the closing </div> of invite code area
const oldInviteClose = `          )}
        </div>
      )}

      {(game.actionLog`; 
const newInviteClose = `          )}

          {/* Leave After Hand checkbox */}
          {(game?.stage !== \"showdown\" && !game?.waiting) && (
            <label className=\"flex items-center gap-2 mt-2 cursor-pointer select-none\">
              <input
                type=\"checkbox\"
                checked={leaveAfterHand}
                onChange={(e) => setLeaveAfterHand(e.target.checked)}
                className=\"w-4 h-4 accent-[#ff00cc] rounded border-[#ff00cc]/40 bg-[#0a0a1a] focus:ring-[#ff00cc] cursor-pointer\"
              />
              <span className=\"text-xs text-[#b0b0ff]/70\">Quitter après cette main</span>
            </label>
          )}
        </div>
      )}

      {(game.actionLog`;
if (content.includes(oldInviteClose)) {
  content = content.replace(oldInviteClose, newInviteClose);
  changed++; console.log('13. Added leave-after-hand checkbox');
} else { console.log('FAIL 13'); process.exit(1); }

fs.writeFileSync('src/app/casino/poker/multi/page.tsx', content);
console.log(`\nDone. Made ${changed} changes.`);
