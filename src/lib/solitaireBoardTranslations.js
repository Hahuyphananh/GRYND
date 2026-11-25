// src/lib/solitaireBoardTranslations.js
//
// The shared Solitaire board's own copy: the one-line legend under the table
// and the appearance drawer trigger. It lives beside the review bundle but in
// its own namespace, because this text is rendered by gameplay too.

export const SOLITAIRE_BOARD_TRANSLATIONS = {
  en: {
    appearance: "Appearance",
    holding: "Holding {held} — drop it on a highlighted pile, or click one to place it.",
    holdWaste: "the waste card",
    holdFoundation: "that foundation card",
    holdRun: "that run",
    stockEmpty: "Stock empty — click the \u21bb slot to turn the waste back over.",
    dragOrClick:
      "Drag a card (or a face-up run) onto a pile — or click it, then click where it should go. A face-down card flips by itself when the card above it leaves.",
  },
  fr: {
    appearance: "Apparence",
    holding:
      "Tu tiens {held} — dépose-la sur une pile surlignée, ou clique dessus pour la placer.",
    holdWaste: "la carte de la défausse",
    holdFoundation: "cette carte de fondation",
    holdRun: "cette suite",
    stockEmpty: "Pioche vide — clique sur l'emplacement \u21bb pour retourner la défausse.",
    dragOrClick:
      "Fais glisser une carte (ou une suite face visible) sur une pile — ou clique dessus, puis clique là où elle doit aller. Une carte face cachée se retourne d'elle-même quand la carte au-dessus la quitte.",
  },
  es: {
    appearance: "Apariencia",
    holding:
      "Sostienes {held}: suéltala en una pila resaltada o haz clic en una para colocarla.",
    holdWaste: "la carta del descarte",
    holdFoundation: "esa carta de la fundación",
    holdRun: "esa secuencia",
    stockEmpty: "Mazo vacío: haz clic en la ranura \u21bb para volver a girar el descarte.",
    dragOrClick:
      "Arrastra una carta (o una secuencia boca arriba) a una pila, o haz clic en ella y luego donde debe ir. Una carta boca abajo se gira sola cuando la carta de encima se va.",
  },
};
