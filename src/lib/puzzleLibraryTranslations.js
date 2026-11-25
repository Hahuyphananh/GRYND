// src/lib/puzzleLibraryTranslations.js
//
// Copy for the strategic puzzle library (categories, difficulty levels,
// objectives, progressive hints and the post-solve explanation). Mounted at
// `puzzleLibrary` in appTextTranslations.js.
//
// THE LIBRARY STORES KEYS, NEVER SENTENCES: each puzzle definition names the
// keys and the parameters (a visible card, a column, a count), so all three
// locales stay in step and no component has to hardcode English.
//
// Every placeholder is a plain `{name}` token, the same convention the Play hub
// already uses (`{remaining}`, `{step}`).

export const PUZZLE_LIBRARY_TRANSLATIONS = {
  en: {
    title: "Strategic puzzles",
    description:
      "Curated positions with a real objective: reveal, open a column, plan the stock or finish a constrained board. Every solution is replayed through the game's own rules.",
    countLabel: "{count} puzzles",
    hub: {
      title: "Strategic puzzles",
      description:
        "Multi-move positions with a real objective: reveal buried cards, free a column, plan the stock or coordinate an endgame. Each one teaches a decision, not a single obvious move.",
      cta: "Open the strategic library",
    },
    levels: {
      beginner: "Beginner",
      intermediate: "Intermediate",
      advanced: "Advanced",
      expert: "Expert",
      master: "Master",
    },
    categories: {
      tableau: {
        name: "Tableau strategy",
        description: "Choose which card or run to move so a hidden card or a free column appears.",
      },
      foundation: {
        name: "Foundation decisions",
        description: "Decide when a card belongs on a foundation and when it is worth more in the tableau.",
      },
      stock: {
        name: "Stock management",
        description: "Plan the stock and waste instead of cycling them at random.",
      },
      sequence: {
        name: "Sequence planning",
        description: "Find an order of moves where an early move makes a later one possible.",
      },
      endgame: {
        name: "Endgame and difficult positions",
        description: "Coordinate several cards in a constrained, nearly finished board.",
      },
    },
    objectives: {
      reveal: "Reveal {count} more face-down card(s).",
      openColumn: "Leave column {column} empty.",
      placeCard: "Put the {card} on {destination}.",
      foundationMilestone: "Reach {total} cards on the foundations.",
      preserve: "Keep the {card} in the tableau.",
      reachState: "Reach the required board state.",
      bestMove: "Find the strongest move.",
      composite: "Complete both parts of the objective.",
      destinationFoundation: "its foundation",
      destinationColumn: "column {column}",
      openAnyColumn: "Leave a column empty.",
    },
    hints: {
      tableau: {
        1: "One column can disappear here. Find the move that unlocks it.",
        2: "Look at column {column}: the {card} is the card that can move.",
        3: "Free the space before you reach for a foundation.",
      },
      foundation: {
        1: "Not every card that fits a foundation belongs there yet.",
        2: "The {card} is the tempting one — check what it still protects.",
        3: "Build the tableau first, then take the foundation gain it enables.",
      },
      stock: {
        1: "The card you need is not on top. The stock is part of the plan.",
        2: "The {card} is already in the waste — you have to cycle to it.",
        3: "Count the draws before you commit; a full pass costs moves.",
      },
      sequence: {
        1: "Two cards are buried. Only one order uncovers both.",
        2: "Start with the {card} in column {column}.",
        3: "The first move is setup, not the payoff.",
      },
      endgame: {
        1: "Space matters more than speed on this board.",
        2: "The {card} is holding the position together.",
        3: "Open the column before you start the foundation run.",
      },
    },
    concepts: {
      tableau: "A hidden card is worth more than a tidy pile: moving the right run buys information.",
      foundation: "Foundations are a promise, not an obligation — a card can do more work in the tableau first.",
      stock: "The stock is a resource to schedule, not a button to press.",
      sequence: "The first move exists to make the second one possible.",
      endgame: "In a tight endgame, the order of two moves decides whether the board opens at all.",
    },
    explanations: {
      why: "The key decision was the order of the moves, not any single one.",
      notice: "What you needed to notice: {notice}",
      alternative: "The obvious alternative was weaker because it spent the move that the objective still needed.",
      delayed: "The greediest move was a trap here — taking it would have closed the line the objective depends on.",
      revealedCount: "{count} face-down card(s) had to come up.",
      openedColumn: "Column {column} had to be emptied.",
      foundationGain: "{count} cards had to reach the foundations.",
      stockPlan: "The waste card had to be cycled back to the top.",
      progress: "The position had to improve before the objective could be met.",
    },
  },
  fr: {
    title: "Énigmes stratégiques",
    description:
      "Des positions choisies avec un objectif réel : révéler, libérer une colonne, planifier la pioche ou terminer un tableau contraint. Chaque solution est rejouée avec les règles du jeu.",
    countLabel: "{count} énigmes",
    hub: {
      title: "Énigmes stratégiques",
      description:
        "Des positions à plusieurs coups avec un objectif réel : révéler des cartes enterrées, libérer une colonne, planifier la pioche ou coordonner une fin de partie. Chacune enseigne une décision, pas un coup évident.",
      cta: "Ouvrir la bibliothèque stratégique",
    },
    levels: {
      beginner: "Débutant",
      intermediate: "Intermédiaire",
      advanced: "Avancé",
      expert: "Expert",
      master: "Maître",
    },
    categories: {
      tableau: {
        name: "Stratégie de tableau",
        description: "Choisir la carte ou la suite à déplacer pour révéler une carte ou libérer une colonne.",
      },
      foundation: {
        name: "Décisions de fondation",
        description: "Savoir quand une carte doit monter en fondation et quand elle vaut plus dans le tableau.",
      },
      stock: {
        name: "Gestion de la pioche",
        description: "Planifier la pioche et la défausse au lieu de les faire tourner au hasard.",
      },
      sequence: {
        name: "Planification de séquence",
        description: "Trouver un ordre de coups où le premier rend le suivant possible.",
      },
      endgame: {
        name: "Fin de partie et positions difficiles",
        description: "Coordonner plusieurs cartes sur un tableau contraint et presque terminé.",
      },
    },
    objectives: {
      reveal: "Révéler {count} carte(s) face cachée de plus.",
      openColumn: "Laisser la colonne {column} vide.",
      placeCard: "Placer le {card} sur {destination}.",
      foundationMilestone: "Atteindre {total} cartes sur les fondations.",
      preserve: "Garder le {card} dans le tableau.",
      reachState: "Atteindre l'état de tableau demandé.",
      bestMove: "Trouver le meilleur coup.",
      composite: "Réaliser les deux parties de l'objectif.",
      destinationFoundation: "sa fondation",
      destinationColumn: "la colonne {column}",
      openAnyColumn: "Laisser une colonne vide.",
    },
    hints: {
      tableau: {
        1: "Une colonne peut disparaître ici. Trouve le coup qui la libère.",
        2: "Regarde la colonne {column} : le {card} est la carte qui peut bouger.",
        3: "Libère la place avant de viser une fondation.",
      },
      foundation: {
        1: "Toute carte qui peut monter en fondation n'a pas forcément à y aller tout de suite.",
        2: "Le {card} est tentant — vérifie ce qu'il protège encore.",
        3: "Construis d'abord le tableau, puis prends le gain de fondation qu'il permet.",
      },
      stock: {
        1: "La carte qu'il te faut n'est pas sur le dessus. La pioche fait partie du plan.",
        2: "Le {card} est déjà dans la défausse — il faut faire tourner la pioche jusqu'à lui.",
        3: "Compte les pioches avant de t'engager ; un tour complet coûte des coups.",
      },
      sequence: {
        1: "Deux cartes sont enterrées. Un seul ordre les révèle toutes les deux.",
        2: "Commence par le {card} de la colonne {column}.",
        3: "Le premier coup prépare le second, il ne le remplace pas.",
      },
      endgame: {
        1: "L'espace compte plus que la vitesse sur ce tableau.",
        2: "Le {card} tient la position ensemble.",
        3: "Ouvre la colonne avant de lancer la série de fondations.",
      },
    },
    concepts: {
      tableau: "Une carte cachée vaut plus qu'un pile bien rangée : le bon déplacement achète de l'information.",
      foundation: "Les fondations sont une promesse, pas une obligation — une carte peut encore travailler dans le tableau.",
      stock: "La pioche est une ressource à planifier, pas un bouton à presser.",
      sequence: "Le premier coup existe pour rendre le second possible.",
      endgame: "Dans une fin serrée, l'ordre de deux coups décide si le tableau s'ouvre.",
    },
    explanations: {
      why: "La décision clé était l'ordre des coups, pas un coup isolé.",
      notice: "Ce qu'il fallait remarquer : {notice}",
      alternative: "L'alternative évidente était plus faible car elle dépensait le coup dont l'objectif avait encore besoin.",
      delayed: "Le coup le plus gourmand était un piège ici — il fermait la ligne dont l'objectif dépend.",
      revealedCount: "{count} carte(s) face cachée devai(en)t être révélée(s).",
      openedColumn: "La colonne {column} devait être vidée.",
      foundationGain: "{count} cartes devaient atteindre les fondations.",
      stockPlan: "La carte de la défausse devait revenir sur le dessus.",
      progress: "La position devait progresser avant que l'objectif puisse être atteint.",
    },
  },
  es: {
    title: "Puzles estratégicos",
    description:
      "Posiciones seleccionadas con un objetivo real: revelar, abrir una columna, planificar el mazo o terminar un tablero limitado. Cada solución se reproduce con las reglas del juego.",
    countLabel: "{count} puzles",
    hub: {
      title: "Puzles estratégicos",
      description:
        "Posiciones de varios movimientos con un objetivo real: revelar cartas enterradas, abrir una columna, planificar el mazo o coordinar un final. Cada una enseña una decisión, no un movimiento obvio.",
      cta: "Abrir la biblioteca estratégica",
    },
    levels: {
      beginner: "Principiante",
      intermediate: "Intermedio",
      advanced: "Avanzado",
      expert: "Experto",
      master: "Maestro",
    },
    categories: {
      tableau: {
        name: "Estrategia del tablero",
        description: "Elegir qué carta o secuencia mover para revelar una carta u abrir una columna.",
      },
      foundation: {
        name: "Decisiones de fundación",
        description: "Decidir cuándo una carta debe subir a la fundación y cuándo vale más en el tablero.",
      },
      stock: {
        name: "Gestión del mazo",
        description: "Planificar el mazo y el descarte en lugar de girarlos al azar.",
      },
      sequence: {
        name: "Planificación de secuencias",
        description: "Encontrar un orden de movimientos donde uno temprano hace posible el siguiente.",
      },
      endgame: {
        name: "Final y posiciones difíciles",
        description: "Coordinar varias cartas en un tablero limitado y casi terminado.",
      },
    },
    objectives: {
      reveal: "Revelar {count} carta(s) boca abajo más.",
      openColumn: "Dejar la columna {column} vacía.",
      placeCard: "Poner el {card} en {destination}.",
      foundationMilestone: "Llegar a {total} cartas en las fundaciones.",
      preserve: "Mantener el {card} en el tablero.",
      reachState: "Alcanzar el estado de tablero requerido.",
      bestMove: "Encontrar el mejor movimiento.",
      composite: "Completar las dos partes del objetivo.",
      destinationFoundation: "su fundación",
      destinationColumn: "la columna {column}",
      openAnyColumn: "Dejar una columna vacía.",
    },
    hints: {
      tableau: {
        1: "Una columna puede desaparecer aquí. Encuentra el movimiento que la libera.",
        2: "Mira la columna {column}: el {card} es la carta que puede moverse.",
        3: "Libera el espacio antes de buscar una fundación.",
      },
      foundation: {
        1: "No toda carta que cabe en una fundación debe subir todavía.",
        2: "El {card} es tentador — comprueba qué sigue protegiendo.",
        3: "Construye primero el tablero y luego toma la ganancia de fundación que permite.",
      },
      stock: {
        1: "La carta que necesitas no está arriba. El mazo forma parte del plan.",
        2: "El {card} ya está en el descarte — hay que girar el mazo hasta él.",
        3: "Cuenta las extracciones antes de comprometerte; una vuelta completa cuesta movimientos.",
      },
      sequence: {
        1: "Hay dos cartas enterradas. Solo un orden revela ambas.",
        2: "Empieza por el {card} de la columna {column}.",
        3: "El primer movimiento prepara el segundo, no es la recompensa.",
      },
      endgame: {
        1: "El espacio importa más que la velocidad en este tablero.",
        2: "El {card} sostiene la posición.",
        3: "Abre la columna antes de lanzar la serie de fundaciones.",
      },
    },
    concepts: {
      tableau: "Una carta oculta vale más que una pila ordenada: el movimiento correcto compra información.",
      foundation: "Las fundaciones son una promesa, no una obligación — una carta puede trabajar antes en el tablero.",
      stock: "El mazo es un recurso que se planifica, no un botón que se pulsa.",
      sequence: "El primer movimiento existe para hacer posible el segundo.",
      endgame: "En un final ajustado, el orden de dos movimientos decide si el tablero se abre.",
    },
    explanations: {
      why: "La decisión clave fue el orden de los movimientos, no uno aislado.",
      notice: "Lo que había que notar: {notice}",
      alternative: "La alternativa obvia era más débil porque gastaba el movimiento que el objetivo aún necesitaba.",
      delayed: "El movimiento más codicioso era una trampa: cerraba la línea de la que depende el objetivo.",
      revealedCount: "Había que revelar {count} carta(s) boca abajo.",
      openedColumn: "Había que vaciar la columna {column}.",
      foundationGain: "Había que llevar {count} cartas a las fundaciones.",
      stockPlan: "La carta del descarte tenía que volver arriba.",
      progress: "La posición tenía que mejorar antes de cumplir el objetivo.",
    },
  },
};
