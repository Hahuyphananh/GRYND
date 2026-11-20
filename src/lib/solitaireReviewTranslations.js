// src/lib/solitaireReviewTranslations.js
//
// Phase 4 copy for the Game Review closing summary, highlights, personal-best
// line, and optional Academy / Practice recommendations. It is merged into the
// existing APP_TEXT_TRANSLATIONS bundle under `solitaireReview`, so the page
// keeps using the same useTranslation()/t() path as the rest of GRYND.

export const SOLITAIRE_REVIEW_TRANSLATIONS = {
  en: {
    modes: {
      solo: "Solo Solitaire",
      daily: "Daily Challenge",
      duel: "Solitaire Duel",
    },
    status: {
      complete: "Complete",
      incomplete: "Incomplete",
      forfeit: "Forfeit",
    },
    ratings: {
      good: "Good",
      great: "Great",
      inaccuracy: "Inaccuracy",
      mistake: "Mistake",
    },
    tags: {
      "revealed-hidden": "Revealed a hidden card",
      "opened-column": "Opened a column",
      "unlocked-sequence": "Unlocked a sequence",
      "foundation-cascade": "Foundation cascade",
      "king-to-empty-column": "King to empty column",
      "foundation-progress": "Foundation progress",
      "pulled-from-foundation": "Pulled from foundation",
      "pointless-shuffle": "Pointless shuffle",
      "wasted-redeal": "Wasted redeal",
    },
    ui: {
      backSolo: "Back to Solo Solitaire",
      backDaily: "Back to Daily Challenge",
      backDuel: "Back to match result",
      headerKicker: "GRYND · game review",
      titleLead: "Every move,",
      titleAccent: "replayed.",
      headerDescription:
        "The exact deal and the validated move log, rebuilt one position at a time. Nothing you do here changes the original game.",
      movesCount: "{count} moves",
      loading: "Rebuilding the game…",
      unavailable: "Review unavailable",
      errorSignedIn: "Sign in to review this game.",
      errorNotFound: "This game could not be found, or it is not yours.",
      errorNotReady: "This game is not ready to review yet.",
      errorIncomplete: "The review data is incomplete.",
      errorUnable: "Unable to load this game review.",
      errorLocal: "This game was saved on another device, so it cannot be reviewed here.",
      replayError: "The stored move history could not be reconstructed",
      replayRejected: " (rejected at move {move})",
      asideAria: "Game review timeline and summary",
      incompleteForfeit:
        "This game ended in a forfeit. Every played move is shown; quality labels are only used where the visible comparison supports them.",
      incompleteNotCompleted:
        "This game ended before the board was solved. Every played move is shown; no completion score is claimed.",
      boardReviewAria: "Board review",
      boardNotice:
        "Review mode — step through the move timeline or use the arrow keys. Play is disabled.",
      initialDeal: "Initial deal",
      moveOf: "Move {move} of {total}",
      startPosition: "Start position",
      moveNavigation: "Move navigation",
      navStart: "Jump to the initial deal",
      navPrev: "Previous move",
      navNext: "Next move",
      navEnd: "Jump to the final position",
      play: "Play",
      pause: "Pause",
      noMovesToReplay: "No moves to replay",
      pauseTitle: "Pause the replay",
      replayTitle: "Replay from the initial deal",
      playTitle: "Play the replay from this position",
      restart: "Restart",
      restartAria: "Restart review from the initial deal",
      speed: "Speed",
      playbackSpeed: "Playback speed",
      hintNext: "← → one move · next: move {next} · Home / End jump · Space play/pause",
      hintEnd: "← → one move · at the end · Home / End jump · Space play/pause",
      moveInsights: "Move insights",
      analyzing: "Analyzing",
      totalMoves: "Total moves",
      completionTime: "Completion time",
      greatMoves: "Great moves",
      goodMoves: "Good moves",
      inaccuracies: "Inaccuracies",
      mistakes: "Mistakes",
      labelsNote:
        "Labels appear only when a legal alternative and the visible-position comparison support them. This is not an accuracy score.",
      analysisError: "Analysis could not be completed. The board and move log still work.",
      moveTimeline: "Move timeline",
      noMovesRecorded: "No moves were recorded.",
      timelineAria: "Move timeline",
      moveAria: "Move {move}: {description}",
      noExtraInsight: "no extra insight",
      proKicker: "GRYND PRO",
      proBody:
        "Today's free match analyses are used. GRYND PRO includes unlimited match analysis — every game, every day.",
      proCta: "Get unlimited analysis",
    },
    moves: {
      draw: "Draw from stock",
      wasteToFoundation: "Waste → {suit}",
      wasteToTableau: "Waste → {column}",
      tableauToFoundation: "{card} → {suit}",
      tableauToTableau: "{card}: {from} → {to}",
      foundationToTableau: "{card}: foundation → {column}",
      unknown: "Move",
      column: "column {column}",
      foundation: "{suit} foundation",
    },
    insight: {
      title: "Move insight",
      played: "Played:",
      whyLabel: "Why it mattered:",
      alternativeLabel: "Alternative:",
      lessonLabel: "Lesson:",
      basis:
        "Visible-board heuristic: it compares legal moves that were actually available. It is not a solver proof, an optimal-move claim, or an accuracy score.",
      partial: "Partial analysis — the first {count} of {total} moves were checked.",
      facts: {
        "revealed-hidden": "The move turned a face-down tableau card face-up.",
        "opened-column":
          "It emptied the source column, so the column can hold a King or a sequence.",
        "king-to-empty-column": "It moved a King into an empty column.",
        "foundation-cascade":
          "It created more than one immediate foundation opportunity.",
        "unlocked-sequence": "A King-led sequence could now use an empty column.",
        "foundation-progress": "It moved a card to its foundation.",
        "pulled-from-foundation": "It took a card back off its foundation.",
        "pointless-shuffle":
          "It moved a tableau card without revealing a new card or freeing a column.",
        "wasted-redeal":
          "It recycled the waste while a productive visible move was available.",
      },
      whyReveal:
        "More exposed cards and reusable columns widen the legal moves available next.",
      whySpace:
        "An empty column is a reusable resource; where a King-led sequence goes can change future mobility.",
      whyFoundation:
        "Foundation progress is real, but a card kept in the tableau can still support a sequence.",
      whyShuffle:
        "The visible board changed, but the move did not expose a card or free a column.",
      whyFoundationProgress:
        "Advancing a card is concrete progress; whether it was the best use of the turn depends on the tableau it leaves behind.",
      whyPositive: "The visible-position comparison ranked it above the other legal moves.",
      whyNegative: "The visible-position comparison ranked another legal move above it.",
      lessonReveal:
        "Look for a move that exposes a hidden card before spending a turn on a shuffle.",
      lessonSpace:
        "Treat an empty column as a resource: use it when a King-led sequence gains more than it gives up.",
      lessonFoundation:
        "A foundation card is safe progress, but check whether the tableau still needs it for a sequence.",
      lessonShuffle:
        "Before recycling or shuffling, compare the visible moves and ask which one changes the board.",
      altHigher:
        "{move} was legal from the same visible board. The visible-position comparison ranked it above the move played; that is evidence, not proof it would have won.",
      altEqual:
        "{move} was legal and ranked equally by the visible-position comparison.",
      altLower:
        "{move} was the strongest other legal move; the visible-position comparison ranked it below the move played.",
    },
    recommendation: {
      title: "Better move",
      instead: "Try instead:",
      show: "Show better move",
      hide: "Back to your move",
      practiceCta: "Practise this situation",
      practiceNote:
        "A short drill on the same idea, played with the real rules. Your review, its selected move and the game result stay as they are.",
      practiceLessonCta: "Open the related lesson",
      confidence: {
        high: "Strong evidence",
        medium: "Supported",
      },
      basis:
        "Best legal move found by the visible-board comparison — not a proven optimal move.",
      demoTitle: "Demonstration · move {move}",
      demoBadge: "Recommended",
      demoNote:
        "This is the recommended move, not the move you played. Your timeline and result are unchanged.",
      demoBack: "Back to your move",
      reasons: {
        foundationOne: "It advances a card to its foundation.",
        foundationMany: "It advances {count} more cards to the foundations.",
        revealOne: "It turns over one more tableau card.",
        revealMany: "It turns over {count} more tableau cards.",
        emptyOne: "It leaves one more column empty.",
        emptyMany: "It leaves {count} more columns empty.",
        productiveInsteadOfDraw: "It makes a concrete move instead of cycling the stock.",
        higherScore: "It scores higher on the visible board.",
      },
    },
    summary: {
      kicker: "Review complete",
      title: "Game summary",
      description:
        "The facts from this replay, with an optional way to keep learning. Nothing here changes the original result.",
      mode: "Mode",
      status: "Result",
      moves: "Total moves",
      duration: "Completion time",
      foundations: "Cards on foundations",
      insights: "Meaningful insights",
      foundationsValue: "{count} / 52",
      insightsValue: "{count}",
      personalBestMatched: "Personal best: {best}. This game matched it.",
      personalBestBehind: "Personal best: {best}. This game was {delta} slower.",
      personalBestFirst: "Your first recorded completion in this mode.",
      personalBestUnavailable: "No comparable history yet for {mode}.",
      analysisUnavailable:
        "Analysis is not available for this game, so no move highlights are shown.",
      analysisPending: "Analysis is still running. Highlights will appear when it finishes.",
      noInsightsComplete:
        "You solved the board. No single decision needed a separate coaching note — a clean finish is a good result.",
      noInsightsIncomplete:
        "The replay is complete. No single decision met the evidence bar for a coaching note.",
      close: "Close review",
      back: "Back to {mode}",
      heuristic:
        "Highlights use the visible-board heuristic from the move analysis. They are not a solver proof or an accuracy score.",
    },
    highlights: {
      title: "Key moments",
      description: "A short set of decisions worth replaying. Select one to jump to it.",
      empty: "No standalone moment met the evidence bar for this game.",
      move: "Move {move}",
      open: "Jump to move {move}",
      noTag: "Notable move",
    },
    learning: {
      title: "Keep learning",
      description: "Optional, based on one verified moment in this game.",
      lessonLabel: "Academy lesson",
      lessonCta: "Open lesson",
      practiceCta: "Practise this skill",
      why: {
        reveal:
          "This game turned over a hidden card. The related lesson covers why reveals create new choices.",
        open:
          "This game freed a tableau column. The related lesson covers how to use that space well.",
        king:
          "This game moved a King into an empty column. The related lesson covers when that trade is worthwhile.",
        cascade:
          "This game created more than one foundation opportunity. The related lesson covers efficient foundation play.",
        keep:
          "This game moved a card back off a foundation. The related lesson covers keeping useful tableau targets.",
        plan:
          "This game changed the tableau without exposing a card or freeing a column. The related lesson covers planning the next move.",
        stock:
          "This game recycled the waste while another visible move was available. The related lesson covers stock-cycle decisions.",
        foundation:
          "This game advanced a foundation. The related lesson covers when foundation progress helps and when it removes a useful target.",
      },
    },
  },
  fr: {
    modes: {
      solo: "Solitaire solo",
      daily: "Défi du jour",
      duel: "Duel de Solitaire",
    },
    status: {
      complete: "Terminé",
      incomplete: "Incomplet",
      forfeit: "Abandon",
    },
    ratings: {
      good: "Bon",
      great: "Excellent",
      inaccuracy: "Imprécision",
      mistake: "Erreur",
    },
    tags: {
      "revealed-hidden": "Carte cachée révélée",
      "opened-column": "Colonne libérée",
      "unlocked-sequence": "Suite débloquée",
      "foundation-cascade": "Enchaînement de fondations",
      "king-to-empty-column": "Roi vers une colonne vide",
      "foundation-progress": "Progression de fondation",
      "pulled-from-foundation": "Carte retirée d'une fondation",
      "pointless-shuffle": "Déplacement sans effet",
      "wasted-redeal": "Recyclage inutile",
    },
    ui: {
      backSolo: "Retour au Solitaire solo",
      backDaily: "Retour au Défi du jour",
      backDuel: "Retour au résultat du match",
      headerKicker: "GRYND · analyse de partie",
      titleLead: "Chaque coup,",
      titleAccent: "rejoué.",
      headerDescription:
        "La donne exacte et le journal de coups validé, reconstruits position par position. Rien ici ne modifie la partie d'origine.",
      movesCount: "{count} coups",
      loading: "Reconstruction de la partie…",
      unavailable: "Analyse indisponible",
      errorSignedIn: "Connecte-toi pour analyser cette partie.",
      errorNotFound: "Cette partie est introuvable ou ne t'appartient pas.",
      errorNotReady: "Cette partie n'est pas encore prête à être analysée.",
      errorIncomplete: "Les données de l'analyse sont incomplètes.",
      errorUnable: "Impossible de charger l'analyse de cette partie.",
      errorLocal:
        "Cette partie a été enregistrée sur un autre appareil et ne peut pas être analysée ici.",
      replayError: "Le journal des coups enregistré n'a pas pu être reconstruit",
      replayRejected: " (refusé au coup {move})",
      asideAria: "Chronologie et résumé de l'analyse",
      incompleteForfeit:
        "Cette partie s'est terminée par un abandon. Tous les coups joués sont affichés ; les labels ne sont utilisés que lorsque la comparaison visible les justifie.",
      incompleteNotCompleted:
        "Cette partie s'est arrêtée avant la résolution du plateau. Tous les coups joués sont affichés ; aucun score de réussite n'est revendiqué.",
      boardReviewAria: "Analyse du plateau",
      boardNotice:
        "Mode analyse — avance dans le journal des coups ou utilise les flèches. Le jeu est désactivé.",
      initialDeal: "Donne initiale",
      moveOf: "Coup {move} sur {total}",
      startPosition: "Position de départ",
      moveNavigation: "Navigation des coups",
      navStart: "Aller à la donne initiale",
      navPrev: "Coup précédent",
      navNext: "Coup suivant",
      navEnd: "Aller à la position finale",
      play: "Lire",
      pause: "Pause",
      noMovesToReplay: "Aucun coup à rejouer",
      pauseTitle: "Mettre le replay en pause",
      replayTitle: "Rejouer depuis la donne initiale",
      playTitle: "Lire le replay depuis cette position",
      restart: "Recommencer",
      restartAria: "Recommencer l'analyse depuis la donne initiale",
      speed: "Vitesse",
      playbackSpeed: "Vitesse de lecture",
      hintNext:
        "← → un coup · suivant : coup {next} · Début / Fin pour sauter · Espace lecture/pause",
      hintEnd:
        "← → un coup · fin atteinte · Début / Fin pour sauter · Espace lecture/pause",
      moveInsights: "Analyses des coups",
      analyzing: "Analyse en cours",
      totalMoves: "Coups joués",
      completionTime: "Temps de résolution",
      greatMoves: "Coups excellents",
      goodMoves: "Bons coups",
      inaccuracies: "Imprécisions",
      mistakes: "Erreurs",
      labelsNote:
        "Les labels n'apparaissent que si une alternative légale et la comparaison des positions visibles les justifient. Ce n'est pas un score de précision.",
      analysisError:
        "L'analyse n'a pas pu être terminée. Le plateau et le journal des coups fonctionnent toujours.",
      moveTimeline: "Journal des coups",
      noMovesRecorded: "Aucun coup enregistré.",
      timelineAria: "Journal des coups",
      moveAria: "Coup {move} : {description}",
      noExtraInsight: "aucune analyse supplémentaire",
      proKicker: "GRYND PRO",
      proBody:
        "Les analyses gratuites du jour sont épuisées. GRYND PRO inclut l'analyse illimitée — chaque partie, chaque jour.",
      proCta: "Obtenir l'analyse illimitée",
    },
    moves: {
      draw: "Piocher",
      wasteToFoundation: "Défausse → {suit}",
      wasteToTableau: "Défausse → {column}",
      tableauToFoundation: "{card} → {suit}",
      tableauToTableau: "{card} : {from} → {to}",
      foundationToTableau: "{card} : fondation → {column}",
      unknown: "Coup",
      column: "colonne {column}",
      foundation: "fondation {suit}",
    },
    insight: {
      title: "Analyse du coup",
      played: "Joué :",
      whyLabel: "Pourquoi c'était important :",
      alternativeLabel: "Alternative :",
      lessonLabel: "Leçon :",
      basis:
        "Heuristique du plateau visible : elle compare les coups légaux réellement disponibles. Ce n'est ni une preuve de solution optimale, ni une revendication de coup parfait, ni un score de précision.",
      partial: "Analyse partielle — les {count} premiers coups sur {total} ont été vérifiés.",
      facts: {
        "revealed-hidden": "Le coup a retourné une carte cachée du tableau.",
        "opened-column":
          "Il a vidé la colonne d'origine, qui peut maintenant accueillir un Roi ou une suite.",
        "king-to-empty-column": "Il a déplacé un Roi vers une colonne vide.",
        "foundation-cascade":
          "Il a créé plus d'une possibilité immédiate de fondation.",
        "unlocked-sequence": "Une suite menée par un Roi peut maintenant utiliser une colonne vide.",
        "foundation-progress": "Il a déplacé une carte vers sa fondation.",
        "pulled-from-foundation": "Il a retiré une carte de sa fondation.",
        "pointless-shuffle":
          "Il a déplacé une carte du tableau sans révéler de carte ni libérer de colonne.",
        "wasted-redeal":
          "Il a recyclé la défausse alors qu'un coup visible productif était disponible.",
      },
      whyReveal:
        "Plus de cartes exposées et de colonnes réutilisables élargissent les coups légaux disponibles.",
      whySpace:
        "Une colonne vide est une ressource réutilisable ; l'endroit où va une suite menée par un Roi peut changer la mobilité future.",
      whyFoundation:
        "La progression en fondation est réelle, mais une carte gardée au tableau peut encore soutenir une suite.",
      whyShuffle:
        "Le plateau visible a changé, mais le coup n'a révélé aucune carte et n'a libéré aucune colonne.",
      whyFoundationProgress:
        "Avancer une carte est un progrès concret ; savoir si c'était le meilleur usage du tour dépend du tableau laissé derrière.",
      whyPositive:
        "La comparaison des positions visibles l'a classé au-dessus des autres coups légaux.",
      whyNegative:
        "La comparaison des positions visibles a classé un autre coup légal au-dessus.",
      lessonReveal:
        "Cherche un coup qui expose une carte cachée avant de consacrer un tour à un déplacement inutile.",
      lessonSpace:
        "Traite une colonne vide comme une ressource : utilise-la quand une suite menée par un Roi apporte plus qu'elle ne coûte.",
      lessonFoundation:
        "Une carte en fondation est un progrès sûr, mais vérifie si le tableau a encore besoin d'elle pour une suite.",
      lessonShuffle:
        "Avant de recycler ou de déplacer sans effet, compare les coups visibles et demande lequel change le plateau.",
      altHigher:
        "{move} était légal depuis le même plateau visible. La comparaison des positions visibles l'a classé au-dessus du coup joué ; c'est un indice, pas la preuve qu'il aurait gagné.",
      altEqual:
        "{move} était légal et classé à égalité par la comparaison des positions visibles.",
      altLower:
        "{move} était le meilleur autre coup légal ; la comparaison des positions visibles l'a classé en dessous du coup joué.",
    },
    recommendation: {
      title: "Meilleur coup",
      instead: "Essaie plutôt :",
      show: "Voir le meilleur coup",
      hide: "Revenir à ton coup",
      practiceCta: "T'entraîner sur cette situation",
      practiceNote:
        "Un court exercice sur la même idée, joué avec les vraies règles. Ta revue, le coup sélectionné et le résultat de la partie restent inchangés.",
      practiceLessonCta: "Ouvrir la leçon liée",
      confidence: {
        high: "Preuves solides",
        medium: "Étayé",
      },
      basis:
        "Meilleur coup légal trouvé par la comparaison du plateau visible — pas la preuve d'un coup optimal.",
      demoTitle: "Démonstration · coup {move}",
      demoBadge: "Recommandé",
      demoNote:
        "Voici le coup recommandé, pas celui que tu as joué. Ton journal et ton résultat restent inchangés.",
      demoBack: "Revenir à ton coup",
      reasons: {
        foundationOne: "Il avance une carte vers sa fondation.",
        foundationMany: "Il avance {count} cartes de plus vers les fondations.",
        revealOne: "Il retourne une carte de plus du tableau.",
        revealMany: "Il retourne {count} cartes de plus du tableau.",
        emptyOne: "Il laisse une colonne vide de plus.",
        emptyMany: "Il laisse {count} colonnes vides de plus.",
        productiveInsteadOfDraw: "Il joue un coup concret au lieu de faire tourner la pioche.",
        higherScore: "Il obtient un meilleur score sur le plateau visible.",
      },
    },
    summary: {
      kicker: "Analyse terminée",
      title: "Résumé de la partie",
      description:
        "Les faits de ce replay, avec une façon facultative de continuer à apprendre. Rien ici ne modifie le résultat d'origine.",
      mode: "Mode",
      status: "Résultat",
      moves: "Coups joués",
      duration: "Temps de résolution",
      foundations: "Cartes sur les fondations",
      insights: "Analyses utiles",
      foundationsValue: "{count} / 52",
      insightsValue: "{count}",
      personalBestMatched: "Meilleur temps : {best}. Cette partie l'a égalé.",
      personalBestBehind: "Meilleur temps : {best}. Cette partie a pris {delta} de plus.",
      personalBestFirst: "Ta première résolution enregistrée dans ce mode.",
      personalBestUnavailable: "Pas encore d'historique comparable pour {mode}.",
      analysisUnavailable:
        "L'analyse n'est pas disponible pour cette partie ; aucun moment clé n'est affiché.",
      analysisPending:
        "L'analyse est en cours. Les moments clés apparaîtront dès qu'elle sera terminée.",
      noInsightsComplete:
        "Tu as résolu le plateau. Aucune décision n'avait besoin d'une note de coaching séparée — une partie propre est un bon résultat.",
      noInsightsIncomplete:
        "Le replay est complet. Aucune décision n'a atteint le seuil de preuve requis pour une note de coaching.",
      close: "Fermer l'analyse",
      back: "Retour à {mode}",
      heuristic:
        "Les moments clés viennent de l'heuristique du plateau visible. Ce n'est ni une preuve de solution optimale ni un score de précision.",
    },
    highlights: {
      title: "Moments clés",
      description:
        "Quelques décisions qui valent le coup d'être revues. Sélectionnes-en une pour y aller.",
      empty: "Aucun moment isolé n'a atteint le seuil de preuve pour cette partie.",
      move: "Coup {move}",
      open: "Aller au coup {move}",
      noTag: "Coup notable",
    },
    learning: {
      title: "Continuer à apprendre",
      description: "Facultatif, à partir d'un moment vérifié de cette partie.",
      lessonLabel: "Leçon de l'Académie",
      lessonCta: "Ouvrir la leçon",
      practiceCta: "Travailler cette compétence",
      why: {
        reveal:
          "Cette partie a révélé une carte cachée. La leçon associée explique pourquoi une révélation ouvre de nouveaux choix.",
        open:
          "Cette partie a libéré une colonne du tableau. La leçon associée explique comment bien utiliser cet espace.",
        king:
          "Cette partie a déplacé un Roi vers une colonne vide. La leçon associée explique quand ce compromis en vaut la peine.",
        cascade:
          "Cette partie a créé plusieurs possibilités de fondation. La leçon associée porte sur les fondations efficaces.",
        keep:
          "Cette partie a retiré une carte d'une fondation. La leçon associée explique comment garder des cibles utiles au tableau.",
        plan:
          "Cette partie a modifié le tableau sans révéler de carte ni libérer de colonne. La leçon associée porte sur la planification du coup suivant.",
        stock:
          "Cette partie a recyclé la défausse alors qu'un autre coup visible était disponible. La leçon associée porte sur les cycles de pioche.",
        foundation:
          "Cette partie a fait avancer une fondation. La leçon associée explique quand cette progression aide et quand elle retire une cible utile.",
      },
    },
  },
  es: {
    modes: {
      solo: "Solitario en solitario",
      daily: "Desafío diario",
      duel: "Duelo de Solitario",
    },
    status: {
      complete: "Completado",
      incomplete: "Incompleto",
      forfeit: "Abandono",
    },
    ratings: {
      good: "Buena",
      great: "Excelente",
      inaccuracy: "Imprecisión",
      mistake: "Error",
    },
    tags: {
      "revealed-hidden": "Carta oculta revelada",
      "opened-column": "Columna liberada",
      "unlocked-sequence": "Secuencia desbloqueada",
      "foundation-cascade": "Cascada de fundaciones",
      "king-to-empty-column": "Rey a columna vacía",
      "foundation-progress": "Progreso de fundación",
      "pulled-from-foundation": "Carta retirada de una fundación",
      "pointless-shuffle": "Movimiento sin efecto",
      "wasted-redeal": "Reciclado inútil",
    },
    ui: {
      backSolo: "Volver al Solitario en solitario",
      backDaily: "Volver al Desafío diario",
      backDuel: "Volver al resultado de la partida",
      headerKicker: "GRYND · análisis de partida",
      titleLead: "Cada jugada,",
      titleAccent: "repetida.",
      headerDescription:
        "El reparto exacto y el registro de jugadas validado, reconstruidos posición a posición. Nada de esto cambia la partida original.",
      movesCount: "{count} jugadas",
      loading: "Reconstruyendo la partida…",
      unavailable: "Análisis no disponible",
      errorSignedIn: "Inicia sesión para analizar esta partida.",
      errorNotFound: "No se encontró esta partida o no es tuya.",
      errorNotReady: "Esta partida aún no está lista para analizarse.",
      errorIncomplete: "Los datos del análisis están incompletos.",
      errorUnable: "No se pudo cargar el análisis de esta partida.",
      errorLocal:
        "Esta partida se guardó en otro dispositivo, así que no se puede analizar aquí.",
      replayError: "No se pudo reconstruir el registro de jugadas guardado",
      replayRejected: " (rechazado en la jugada {move})",
      asideAria: "Cronología y resumen del análisis",
      incompleteForfeit:
        "Esta partida terminó por abandono. Se muestran todas las jugadas; las etiquetas solo se usan cuando la comparación visible las respalda.",
      incompleteNotCompleted:
        "Esta partida terminó antes de resolver el tablero. Se muestran todas las jugadas; no se reclama ninguna puntuación de finalización.",
      boardReviewAria: "Análisis del tablero",
      boardNotice:
        "Modo análisis: avanza por la cronología de jugadas o usa las flechas. El juego está desactivado.",
      initialDeal: "Reparto inicial",
      moveOf: "Jugada {move} de {total}",
      startPosition: "Posición inicial",
      moveNavigation: "Navegación de jugadas",
      navStart: "Ir al reparto inicial",
      navPrev: "Jugada anterior",
      navNext: "Jugada siguiente",
      navEnd: "Ir a la posición final",
      play: "Reproducir",
      pause: "Pausa",
      noMovesToReplay: "No hay jugadas que reproducir",
      pauseTitle: "Pausar la repetición",
      replayTitle: "Repetir desde el reparto inicial",
      playTitle: "Reproducir desde esta posición",
      restart: "Reiniciar",
      restartAria: "Reiniciar el análisis desde el reparto inicial",
      speed: "Velocidad",
      playbackSpeed: "Velocidad de reproducción",
      hintNext:
        "← → una jugada · siguiente: jugada {next} · Inicio / Fin para saltar · Espacio reproducir/pausar",
      hintEnd:
        "← → una jugada · final alcanzado · Inicio / Fin para saltar · Espacio reproducir/pausar",
      moveInsights: "Análisis de jugadas",
      analyzing: "Analizando",
      totalMoves: "Jugadas totales",
      completionTime: "Tiempo de resolución",
      greatMoves: "Jugadas excelentes",
      goodMoves: "Jugadas buenas",
      inaccuracies: "Imprecisiones",
      mistakes: "Errores",
      labelsNote:
        "Las etiquetas solo aparecen cuando una alternativa legal y la comparación de posiciones visibles las respaldan. No es una puntuación de precisión.",
      analysisError:
        "El análisis no pudo completarse. El tablero y el registro de jugadas siguen funcionando.",
      moveTimeline: "Cronología de jugadas",
      noMovesRecorded: "No se registraron jugadas.",
      timelineAria: "Cronología de jugadas",
      moveAria: "Jugada {move}: {description}",
      noExtraInsight: "sin análisis adicional",
      proKicker: "GRYND PRO",
      proBody:
        "Los análisis gratuitos de hoy se han agotado. GRYND PRO incluye análisis ilimitado: cada partida, cada día.",
      proCta: "Obtener análisis ilimitado",
    },
    moves: {
      draw: "Robar del mazo",
      wasteToFoundation: "Descarte → {suit}",
      wasteToTableau: "Descarte → {column}",
      tableauToFoundation: "{card} → {suit}",
      tableauToTableau: "{card}: {from} → {to}",
      foundationToTableau: "{card}: fundación → {column}",
      unknown: "Jugada",
      column: "columna {column}",
      foundation: "fundación {suit}",
    },
    insight: {
      title: "Análisis de la jugada",
      played: "Jugada:",
      whyLabel: "Por qué importó:",
      alternativeLabel: "Alternativa:",
      lessonLabel: "Lección:",
      basis:
        "Heurística del tablero visible: compara las jugadas legales que estaban disponibles. No es una prueba de solución óptima, ni una afirmación de jugada perfecta, ni una puntuación de precisión.",
      partial: "Análisis parcial: se revisaron las primeras {count} de {total} jugadas.",
      facts: {
        "revealed-hidden": "La jugada giró una carta oculta del tablero.",
        "opened-column":
          "Vació la columna de origen, que ahora puede recibir un Rey o una secuencia.",
        "king-to-empty-column": "Movió un Rey a una columna vacía.",
        "foundation-cascade":
          "Creó más de una oportunidad inmediata de fundación.",
        "unlocked-sequence": "Una secuencia encabezada por un Rey ya puede usar una columna vacía.",
        "foundation-progress": "Movió una carta a su fundación.",
        "pulled-from-foundation": "Retiró una carta de su fundación.",
        "pointless-shuffle":
          "Movió una carta del tablero sin revelar otra ni liberar una columna.",
        "wasted-redeal":
          "Recicló el descarte mientras había otra jugada visible productiva.",
      },
      whyReveal:
        "Más cartas expuestas y columnas reutilizables amplían las jugadas legales disponibles.",
      whySpace:
        "Una columna vacía es un recurso reutilizable; dónde va una secuencia encabezada por un Rey puede cambiar la movilidad futura.",
      whyFoundation:
        "El progreso de fundación es real, pero una carta que se queda en el tablero aún puede sostener una secuencia.",
      whyShuffle:
        "El tablero visible cambió, pero la jugada no reveló una carta ni liberó una columna.",
      whyFoundationProgress:
        "Avanzar una carta es progreso concreto; si fue el mejor uso del turno depende del tablero que deja.",
      whyPositive:
        "La comparación de posiciones visibles la clasificó por encima de las demás jugadas legales.",
      whyNegative:
        "La comparación de posiciones visibles clasificó otra jugada legal por encima.",
      lessonReveal:
        "Busca una jugada que exponga una carta oculta antes de dedicar un turno a un movimiento sin efecto.",
      lessonSpace:
        "Trata una columna vacía como un recurso: úsala cuando una secuencia encabezada por un Rey aporte más de lo que cuesta.",
      lessonFoundation:
        "Una carta en la fundación es progreso seguro, pero comprueba si el tablero aún la necesita para una secuencia.",
      lessonShuffle:
        "Antes de reciclar o mover sin efecto, compara las jugadas visibles y pregunta cuál cambia el tablero.",
      altHigher:
        "{move} era legal desde el mismo tablero visible. La comparación de posiciones visibles la clasificó por encima de la jugada realizada; es una evidencia, no la prueba de que habría ganado.",
      altEqual:
        "{move} era legal y quedó igualada en la comparación de posiciones visibles.",
      altLower:
        "{move} era la mejor otra jugada legal; la comparación de posiciones visibles la clasificó por debajo de la jugada realizada.",
    },
    recommendation: {
      title: "Mejor jugada",
      instead: "Prueba en su lugar:",
      show: "Ver la mejor jugada",
      hide: "Volver a tu jugada",
      practiceCta: "Practicar esta situación",
      practiceNote:
        "Un ejercicio corto sobre la misma idea, jugado con las reglas reales. Tu revisión, la jugada seleccionada y el resultado de la partida no cambian.",
      practiceLessonCta: "Abrir la lección relacionada",
      confidence: {
        high: "Evidencia sólida",
        medium: "Respaldada",
      },
      basis:
        "Mejor jugada legal encontrada por la comparación del tablero visible; no es la prueba de una jugada óptima.",
      demoTitle: "Demostración · jugada {move}",
      demoBadge: "Recomendada",
      demoNote:
        "Esta es la jugada recomendada, no la que hiciste. Tu cronología y tu resultado no cambian.",
      demoBack: "Volver a tu jugada",
      reasons: {
        foundationOne: "Adelanta una carta a su fundación.",
        foundationMany: "Adelanta {count} cartas más a las fundaciones.",
        revealOne: "Gira una carta más del tablero.",
        revealMany: "Gira {count} cartas más del tablero.",
        emptyOne: "Deja una columna vacía más.",
        emptyMany: "Deja {count} columnas vacías más.",
        productiveInsteadOfDraw: "Hace una jugada concreta en lugar de ciclar el mazo.",
        higherScore: "Puntúa mejor en el tablero visible.",
      },
    },
    summary: {
      kicker: "Análisis completado",
      title: "Resumen de la partida",
      description:
        "Los datos de esta repetición, con una forma opcional de seguir aprendiendo. Nada de esto cambia el resultado original.",
      mode: "Modo",
      status: "Resultado",
      moves: "Jugadas totales",
      duration: "Tiempo de resolución",
      foundations: "Cartas en las fundaciones",
      insights: "Análisis útiles",
      foundationsValue: "{count} / 52",
      insightsValue: "{count}",
      personalBestMatched: "Mejor tiempo: {best}. Esta partida lo igualó.",
      personalBestBehind: "Mejor tiempo: {best}. Esta partida tardó {delta} más.",
      personalBestFirst: "Tu primera resolución registrada en este modo.",
      personalBestUnavailable: "Todavía no hay historial comparable de {mode}.",
      analysisUnavailable:
        "El análisis no está disponible para esta partida, así que no se muestran momentos clave.",
      analysisPending:
        "El análisis sigue en curso. Los momentos clave aparecerán cuando termine.",
      noInsightsComplete:
        "Has resuelto el tablero. Ninguna decisión necesitaba una nota de coaching aparte: terminar limpio ya es un buen resultado.",
      noInsightsIncomplete:
        "La repetición está completa. Ninguna decisión alcanzó el umbral de evidencia para una nota de coaching.",
      close: "Cerrar análisis",
      back: "Volver a {mode}",
      heuristic:
        "Los momentos clave usan la heurística del tablero visible del análisis. No son una prueba de solución óptima ni una puntuación de precisión.",
    },
    highlights: {
      title: "Momentos clave",
      description:
        "Una selección breve de decisiones que merece la pena repasar. Elige una para ir a ella.",
      empty: "Ningún momento aislado alcanzó el umbral de evidencia en esta partida.",
      move: "Jugada {move}",
      open: "Ir a la jugada {move}",
      noTag: "Jugada notable",
    },
    learning: {
      title: "Sigue aprendiendo",
      description: "Opcional, basado en un momento verificado de esta partida.",
      lessonLabel: "Lección de la Academia",
      lessonCta: "Abrir lección",
      practiceCta: "Practicar esta habilidad",
      why: {
        reveal:
          "Esta partida reveló una carta oculta. La lección relacionada explica por qué una revelación crea nuevas opciones.",
        open:
          "Esta partida liberó una columna del tablero. La lección relacionada explica cómo aprovechar ese espacio.",
        king:
          "Esta partida movió un Rey a una columna vacía. La lección relacionada explica cuándo compensa ese intercambio.",
        cascade:
          "Esta partida creó más de una oportunidad de fundación. La lección relacionada trata las fundaciones eficientes.",
        keep:
          "Esta partida retiró una carta de una fundación. La lección relacionada explica cómo conservar objetivos útiles en el tablero.",
        plan:
          "Esta partida cambió el tablero sin revelar una carta ni liberar una columna. La lección relacionada trata la planificación de la siguiente jugada.",
        stock:
          "Esta partida recicló el descarte mientras había otra jugada visible disponible. La lección relacionada trata las decisiones de ciclo del mazo.",
        foundation:
          "Esta partida avanzó una fundación. La lección relacionada explica cuándo ayuda ese progreso y cuándo elimina un objetivo útil.",
      },
    },
  },
};
