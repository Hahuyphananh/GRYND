import re

with open('src/app/casino/poker/multi/page.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: Add settle call in checkForWinner (first winner.id === myId block)
old1 = """      if (winner.id === myId) {
        audioRef.current.playWin();
        setBalance((prev) => prev + pot);
        fetchUserTokens();
      } else {"""
new1 = """      if (winner.id === myId) {
        audioRef.current.playWin();
        setBalance((prev) => prev + pot);
        fetchUserTokens();
        fetch("/api/poker/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winnerId: myId, amount: pot }),
        }).catch(() => {});
      } else {"""

# Fix 2: Add settle call in showdown (second winner.id === myId block)
old2 = """    if (winner.id === myId) {
      audioRef.current.playWin();
      setBalance((prev) => prev + game.pot);
      fetchUserTokens();
      confetti({"""
new2 = """    if (winner.id === myId) {
      audioRef.current.playWin();
      setBalance((prev) => prev + game.pot);
      fetchUserTokens();
      fetch("/api/poker/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerId: myId, amount: game.pot }),
      }).catch(() => {});
      confetti({"""

count1 = content.count(old1)
count2 = content.count(old2)

print(f"Found {count1} occurrences of checkForWinner block")
print(f"Found {count2} occurrences of showdown block")

if old1 in content:
    content = content.replace(old1, new1, 1)
    print("Applied fix 1 (checkForWinner)")
else:
    print("WARNING: old1 not found!")

if old2 in content:
    content = content.replace(old2, new2, 1)
    print("Applied fix 2 (showdown)")
else:
    print("WARNING: old2 not found!")

with open('src/app/casino/poker/multi/page.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done writing file")
