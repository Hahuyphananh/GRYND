async function handler({ startPosition, betAmount }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { error: "Utilisateur non authentifié" };
  }

  // Vérifier le montant du pari
  if (!betAmount || betAmount <= 0) {
    return { error: "Montant du pari invalide" };
  }

  // Récupérer les jetons de l'utilisateur
  const userTokensResponse = await fetch("/api/get-user-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: session.user.id }),
  });

  if (!userTokensResponse.ok) {
    return { error: "Erreur lors de la récupération des jetons" };
  }

  const userTokens = await userTokensResponse.json();
  if (betAmount > userTokens.data.balance) {
    return { error: "Solde insuffisant" };
  }

  // Définir les multiplicateurs et leurs positions
  const multipliers = [
    10, 5, 3, 2, 1.5, 1.2, 1, 0.6, 0.4, 0.2, 0.4, 0.6, 1, 1.2, 1.5, 2, 3, 5, 10,
  ];
  const totalWidth = (multipliers.length - 1) * 24;
  const startX = 250 - totalWidth / 2;

  // Générer le chemin de la balle
  const path = [];
  let currentX = 250; // Position de départ X
  let currentY = 50; // Position de départ Y
  path.push({ x: currentX, y: currentY });

  // Simuler le chemin à travers les chevilles
  for (let row = 0; row < 19; row++) {
    currentY += 22; // Espacement vertical entre les rangées

    // 50% de chance d'aller à gauche ou à droite
    const direction = Math.random() < 0.5 ? -1 : 1;
    currentX += direction * 12; // Déplacement horizontal

    path.push({ x: currentX, y: currentY });
  }

  // Déterminer l'index du multiplicateur final
  const finalX = currentX;
  const multiplierIndex = Math.round((finalX - startX) / 24);
  const clampedIndex = Math.max(
    0,
    Math.min(multipliers.length - 1, multiplierIndex)
  );

  // Ajuster la position X finale pour s'aligner exactement avec le multiplicateur
  const finalMultiplierX = startX + clampedIndex * 24;
  path[path.length - 1].x = finalMultiplierX;
  path[path.length - 1].y = 460; // Position Y finale fixe

  const multiplier = multipliers[clampedIndex];
  const winAmount = betAmount * multiplier;

  // Mettre à jour les jetons de l'utilisateur
  const updateResponse = await fetch("/api/update-token-balance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: session.user.id,
      amount: -betAmount + winAmount,
    }),
  });

  if (!updateResponse.ok) {
    return { error: "Erreur lors de la mise à jour du solde" };
  }

  // Enregistrer la partie
  await fetch("/api/create-plinko-game", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: session.user.id,
      betAmount,
      multiplier,
      winAmount,
      path: JSON.stringify(path),
    }),
  });

  return {
    path,
    winAmount,
    multiplier,
  };
}
export async function POST(request) {
  return handler(await request.json());
}