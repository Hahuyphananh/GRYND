// src/lib/learnPracticeTranslations.js
//
// Copy for the independent Practice area: the four skill areas, the sixteen
// skills, the eighteen validated exercises, and the Practice interface.
//
// It is merged into LEARN_TRANSLATIONS under `practice`, so components keep using
// the app-wide `t("learn.practice...")` convention. Every string a player can see
// in Practice lives here in EN, FR and ES: no exercise content is hardcoded in a
// component, and no language falls back to another.
//
// Wording rule: an exercise describes the objective it actually validates. A
// hint offers "one checked way forward", never "the best move", because the
// evaluator can prove legality and completion but cannot prove optimality.

export const LEARN_PRACTICE_TRANSLATIONS = {
  en: {
    kicker: "Independent practice",
    title: "Practice one skill at a time.",
    description:
      "Short drills on prepared boards, played with the real rules. Practice sits beside the courses and never changes your lesson history or your competitive record.",
    setupKicker: "Build your drill",
    setupTitle: "Choose a skill and a level",
    categoryLabel: "Skill area",
    skillLabel: "Skill",
    difficultyLabel: "Difficulty",
    start: "Start practice",
    exerciseCount: "{count} exercises",
    exerciseCountOne: "1 exercise",
    noExercises: "No validated exercise is available for this choice yet.",
    objective: "Objective",
    skillFocus: "What this trains",
    difficultyReason: "Why this level",
    hint: "Hint",
    nextHint: "Next hint",
    noMoreHints: "No more hints for this exercise. Restart it or try another drill.",
    checkedMove: "Play the checked move",
    checkedMoveNote: "One proven-legal way forward. Other legal moves may also reach the objective.",
    restart: "Restart exercise",
    feedbackCorrect: "Objective advanced.",
    feedbackComplete: "Objective reached.",
    feedbackOffGoal: "Legal move, but the objective is not reached yet.",
    feedbackIllegal: "That move is not allowed here.",
    completeTitle: "Exercise complete",
    completeLead:
      "You reached the objective. Running the same drill again is what makes the pattern automatic.",
    movesUsed: "Moves: {count}",
    hintsUsed: "Hints: {count}",
    another: "Try another exercise",
    backToSetup: "Return to practice",
    fromReviewKicker: "From your Game Review",
    fromReviewTitle: "You are practising a situation from a review.",
    fromReviewBody:
      "This drill uses a prepared, validated board that teaches the same idea. Your reviewed game, its result and its analysis are untouched.",
    backToReview: "Back to the review",
    fromReviewProgress: "From Game Review: {attempts} attempted · {completions} completed",
    progressTitle: "Practice progress",
    progressEmpty: "No practice attempts on this device yet.",
    attempted: "Attempts",
    completed: "Completed",
    successRate: "Success rate",
    hintTotal: "Hints",
    exercisesDone: "{completed} of {total} exercises completed",
    categoryProgress: "By skill area",
    guestNote: "Guest practice is saved on this device.",
    accountNote: "Practice is saved on this device for your account.",
    separateNote:
      "Practice progress is separate from course progress and from ranked results. No Elo, trophy or level changes here.",
    boardAria: "Practice board",
    setupAria: "Practice setup",
    completeAria: "Exercise complete",
    difficulty: {
      beginner: {
        label: "Beginner",
        description: "One rule to apply, with the target visible on the board.",
      },
      intermediate: {
        label: "Intermediate",
        description: "Two linked moves, or a choice between legal moves.",
      },
      advanced: {
        label: "Advanced",
        description: "A plan across several moves, where order or freed space matters.",
      },
    },
    categories: {
      tableau: {
        title: "Tableau",
        description: "Build runs, reveal hidden cards and manage empty columns.",
      },
      foundations: {
        title: "Foundations",
        description: "Decide when a card belongs on a foundation and when it is still needed below.",
      },
      "stock-and-waste": {
        title: "Stock and waste",
        description: "Plan draws, recycle the stock and use the card you turn over.",
      },
      strategy: {
        title: "Strategy",
        description: "Compare moves by what they reveal and what they set up next.",
      },
    },
    skills: {
      "alternating-colors": {
        title: "Alternating colours",
        focus: "A tableau card must be the opposite colour and one rank lower.",
        hint1: "Compare the colour of the card you want to move with the card it would land on.",
        hint2: "Only the opposite colour fits, one rank lower. The checked move shows one placement.",
      },
      "descending-sequences": {
        title: "Descending sequences",
        focus: "Tableau runs descend by exactly one rank.",
        hint1: "Count down from the card you are building on.",
        hint2: "Look for a card exactly one rank lower than the top card.",
      },
      "moving-runs": {
        title: "Moving card runs",
        focus: "A legal face-up run moves as a single unit.",
        hint1: "Check whether the cards below the head already form a legal run.",
        hint2: "Move the head of the run onto a legal target; the cards below it follow.",
      },
      "reveal-hidden-cards": {
        title: "Revealing hidden cards",
        focus: "Clear the face-up cards above a face-down card to turn it over.",
        hint1: "Which column still hides a face-down card under face-up cards?",
        hint2: "Find a legal home for the top face-up card so the hidden card flips.",
      },
      "opening-empty-columns": {
        title: "Opening empty columns",
        focus: "Only a King, or a run headed by a King, can start an empty column.",
        hint1: "An empty column accepts a King or a King-headed run.",
        hint2: "Gather the King and its run first, then move the King into the empty column.",
      },
      "managing-kings": {
        title: "Managing Kings",
        focus: "A King move costs a column, so plan what the freed column will hold.",
        hint1: "Moving a King frees the column it leaves behind.",
        hint2: "Relocate one King-headed run, then use the column it vacated.",
      },
      "foundation-timing": {
        title: "Foundation timing",
        focus: "A foundation builds upward from its Ace, one rank at a time.",
        hint1: "A foundation only accepts the next card in that suit.",
        hint2: "Start the foundation with the Ace; the next rank becomes legal afterwards.",
      },
      "keeping-tableau-cards": {
        title: "Keeping cards in the tableau",
        focus: "A card that can still receive another card is doing useful work in the tableau.",
        hint1: "Before sending a card up, check which card could still land on it.",
        hint2: "Leave the card that receives another card in the tableau, and build the foundation around it.",
      },
      "efficient-foundations": {
        title: "Building foundations efficiently",
        focus: "Each foundation card you play makes the next rank legal.",
        hint1: "Play the foundation cards in rank order.",
        hint2: "Ace, then two, then three: one card at a time.",
      },
      "stock-draw-decisions": {
        title: "Stock draw decisions",
        focus: "A draw turns one stock card face up into the waste.",
        hint1: "The top of the waste is the only card a draw gives you.",
        hint2: "Draw once, then check whether the waste card has a legal home.",
      },
      "waste-pile-management": {
        title: "Waste pile management",
        focus: "Play from the waste before drawing again.",
        hint1: "A legal move from the waste keeps the next draw useful.",
        hint2: "Clear the waste card onto the tableau, then draw the next card.",
      },
      "stock-cycle-planning": {
        title: "Stock cycle planning",
        focus: "When the stock is empty, a draw turns the waste back into the stock.",
        hint1: "With the stock empty, drawing recycles the waste in reverse order.",
        hint2: "Take the whole cycle, then play the card that returns to the top.",
      },
      "planning-ahead": {
        title: "Planning ahead",
        focus: "Check where a move leads and what it will expose before you play it.",
        hint1: "Look at what the column exposes once the top card leaves.",
        hint2: "Move the card that uncovers a card with a legal home.",
      },
      "choosing-reveals": {
        title: "Choosing which card to reveal",
        focus: "Compare what each hidden card could unlock.",
        hint1: "Two columns hide cards: which face-up card has a legal home?",
        hint2: "Turn over the hidden card whose column you can clear.",
      },
      "avoiding-blocked-positions": {
        title: "Avoiding blocked positions",
        focus: "A covered face-down card stalls the whole column.",
        hint1: "Find the face-up card covering a hidden card.",
        hint2: "Move the covering card to a legal target, then place the revealed card.",
      },
      "comparing-alternative-moves": {
        title: "Comparing alternative moves",
        focus: "Two legal orders can reach the same arrangement.",
        hint1: "The same three cards can be stacked in either order.",
        hint2: "Build the run step by step; here the order does not matter.",
      },
    },
    exercises: {
      "alternating-colors": {
        title: "Alternating colours",
        objective: "Place the 7 of hearts on the 8 of spades.",
        explanation: "A tableau placement must be one rank lower and the opposite colour.",
        success: "A red 7 belongs on a black 8.",
        rationale: "One rule, one visible target, one move.",
      },
      "alternating-colors-two": {
        title: "Alternating colours, chained",
        objective: "Build the 9 of spades, 8 of hearts and 7 of clubs into one run.",
        explanation: "Each card is one rank lower than the one above it, and the colours alternate.",
        success: "The club 8 looked similar but could not sit on a black 9.",
        rationale: "Two linked placements with a same-colour decoy.",
      },
      "descending-sequences": {
        title: "Descending sequences",
        objective: "Place the 6 of spades on the 7 of hearts.",
        explanation: "Tableau runs descend by exactly one rank, so a 6 goes on a 7.",
        success: "The run descends by one rank, as it should.",
        rationale: "One rank check, one visible target.",
      },
      "moving-runs": {
        title: "Moving card runs",
        objective: "Move the 10, 9, 8 run onto the Jack of spades.",
        explanation: "A legal face-up run moves as one unit; its cards do not move one at a time.",
        success: "The whole run arrived together and the source column is empty.",
        rationale: "One move, but the player must recognise three cards as a single run.",
      },
      "moving-runs-two": {
        title: "Moving runs, then extending",
        objective: "Move the Queen-Jack run onto the King of hearts, then add the 10 of clubs.",
        explanation: "First the run moves as a unit, then the 10 extends the new run.",
        success: "Four cards in one run: Queen-Jack moved together and the 10 completed it.",
        rationale: "Two linked moves with different jobs: transport a run, then extend it.",
      },
      "reveal-hidden-cards": {
        title: "Revealing hidden cards",
        objective: "Reveal the face-down card in the first column.",
        explanation: "Clearing the face-up card above a hidden card turns the hidden card face up.",
        success: "The hidden card is face up, so its identity is now known.",
        rationale: "One placement whose point is the reveal it causes.",
      },
      "opening-empty-columns": {
        title: "Opening empty columns",
        objective: "Finish with the King of hearts and its Queen in the last column.",
        explanation: "Only a King, or a run headed by a King, can start an empty column.",
        success: "The King and Queen use the empty column, and the old columns are free.",
        rationale: "Two moves in either order, both requiring the empty-column rule.",
      },
      "managing-kings": {
        title: "Managing Kings",
        objective:
          "Move the spade King's run to the empty column, then the diamond King's run into the freed column.",
        explanation: "A King move costs one column, so the useful plan frees another column.",
        success: "One King moved, one column freed, and the second King had a home.",
        rationale: "Two King relocations where the first creates the space the second needs.",
      },
      "foundation-timing": {
        title: "Foundation timing",
        objective: "Put both heart cards on the heart foundation.",
        explanation: "A foundation only accepts the next rank in its suit, so the Ace has to go first.",
        success: "The foundation builds in order: Ace, then two.",
        rationale: "One rule applied twice, with the second move legal only after the first.",
      },
      "keeping-tableau-cards": {
        title: "Keeping cards in the tableau",
        objective:
          "Build the heart foundation to the two, but keep the 3 of hearts so the 2 of spades still has a home.",
        explanation: "A card that can still receive another card is doing useful work in the tableau.",
        success: "The foundation advanced and the 3 of hearts stayed where it was needed.",
        rationale:
          "Three moves with a real trade-off: progress a foundation without removing a target.",
      },
      "efficient-foundations": {
        title: "Building foundations efficiently",
        objective: "Build the heart foundation up to the 3.",
        explanation: "Each foundation card makes the next rank legal, so the order is fixed.",
        success: "Ace, two, three: each card unlocked the next.",
        rationale: "Three ordered moves; the reasoning is the dependency between them.",
      },
      "stock-draw-decisions": {
        title: "Stock draw decisions",
        objective: "Draw once and place the card you drew from the waste.",
        explanation: "A draw turns exactly one stock card face up into the waste.",
        success: "Drawn once, played once: the waste card had a legal home.",
        rationale: "Two moves, both visible on the board.",
      },
      "waste-pile-management": {
        title: "Waste pile management",
        objective:
          "Draw, place the 7 of clubs, then draw and place the 6 of diamonds on the same column.",
        explanation:
          "Playing from the waste before drawing again keeps the next draw usable on the same column.",
        success: "Both drawn cards found a home and the waste is empty.",
        rationale:
          "Four moves where playing the waste card first is what makes the next draw useful.",
      },
      "stock-cycle-planning": {
        title: "Stock cycle planning",
        objective: "Go all the way round the stock once, then place the 8 of spades on the 9 of hearts.",
        explanation:
          "When the stock is empty, a draw turns the waste back into the stock, so a full cycle is part of the plan.",
        success: "One full cycle, then the card returned to the top of the waste and found a home.",
        rationale: "A five-move plan that only completes after the stock has been recycled.",
      },
      "planning-ahead": {
        title: "Planning ahead",
        objective: "Free the 6 of diamonds, then place it on the 7 of clubs.",
        explanation: "Check what a column exposes before you move: the point is the second move.",
        success: "The 5 made room, the 6 was revealed, and it had a home.",
        rationale: "Two moves where the first is only worth it for the reveal it produces.",
      },
      "choosing-reveals": {
        title: "Choosing which card to reveal",
        objective: "Reveal both face-down cards.",
        explanation:
          "Compare what each reveal could unlock; here the two visible 7s each have a legal target.",
        success: "Both hidden cards are known, and the order did not matter.",
        rationale: "Two independent reveals; the player compares two legal choices.",
      },
      "avoiding-blocked-positions": {
        title: "Avoiding blocked positions",
        objective: "Free the face-down card, then place it on the 9 of diamonds.",
        explanation:
          "A covered face-down card stalls the whole column, so the covering card needs a home.",
        success: "The blocked column is empty and the revealed card is in play.",
        rationale:
          "Two moves where the reveal only happens because the first card had a legal home.",
      },
      "comparing-alternative-moves": {
        title: "Comparing alternative moves",
        objective:
          "Stack the 7 of hearts, 6 of spades and 5 of diamonds into one run. Either order works.",
        explanation:
          "Two legal orders reach the same arrangement; compare the result, not just the first move.",
        success: "Either order produced the same run.",
        rationale:
          "A two-move plan with two valid orders, testing comparison rather than a script.",
      },
    },
  },

  fr: {
    kicker: "Entraînement autonome",
    title: "Travaille une compétence à la fois.",
    description:
      "Des exercices courts sur des plateaux préparés, joués avec les vraies règles. L'entraînement accompagne les cours et ne modifie ni ton historique de leçons ni tes résultats compétitifs.",
    setupKicker: "Compose ton exercice",
    setupTitle: "Choisis une compétence et un niveau",
    categoryLabel: "Domaine",
    skillLabel: "Compétence",
    difficultyLabel: "Difficulté",
    start: "Commencer l'entraînement",
    exerciseCount: "{count} exercices",
    exerciseCountOne: "1 exercice",
    noExercises: "Aucun exercice validé n'est encore disponible pour ce choix.",
    objective: "Objectif",
    skillFocus: "Ce que ça travaille",
    difficultyReason: "Pourquoi ce niveau",
    hint: "Indice",
    nextHint: "Indice suivant",
    noMoreHints: "Plus d'indices pour cet exercice. Recommence-le ou choisis un autre exercice.",
    checkedMove: "Jouer le coup vérifié",
    checkedMoveNote:
      "Une suite vérifiée et légale. D'autres coups légaux peuvent aussi atteindre l'objectif.",
    restart: "Recommencer l'exercice",
    feedbackCorrect: "Objectif avancé.",
    feedbackComplete: "Objectif atteint.",
    feedbackOffGoal: "Coup légal, mais l'objectif n'est pas encore atteint.",
    feedbackIllegal: "Ce coup n'est pas autorisé ici.",
    completeTitle: "Exercice terminé",
    completeLead:
      "Tu as atteint l'objectif. Refaire le même exercice est ce qui rend le réflexe automatique.",
    movesUsed: "Coups : {count}",
    hintsUsed: "Indices : {count}",
    another: "Essayer un autre exercice",
    backToSetup: "Retour à l'entraînement",
    fromReviewKicker: "Depuis ta revue de partie",
    fromReviewTitle: "Tu travailles une situation vue dans une revue.",
    fromReviewBody:
      "Cet exercice utilise un plateau préparé et validé qui enseigne la même idée. Ta partie revue, son résultat et son analyse restent inchangés.",
    backToReview: "Revenir à la revue",
    fromReviewProgress:
      "Depuis la revue : {attempts} tentatives · {completions} réussies",
    progressTitle: "Progression de l'entraînement",
    progressEmpty: "Aucun essai enregistré sur cet appareil pour l'instant.",
    attempted: "Essais",
    completed: "Réussis",
    successRate: "Taux de réussite",
    hintTotal: "Indices",
    exercisesDone: "{completed} exercices terminés sur {total}",
    categoryProgress: "Par domaine",
    guestNote: "L'entraînement invité est enregistré sur cet appareil.",
    accountNote: "L'entraînement est enregistré sur cet appareil pour ton compte.",
    separateNote:
      "La progression de l'entraînement est séparée des cours et des résultats classés. Aucun Elo, trophée ou niveau ne change ici.",
    boardAria: "Plateau d'entraînement",
    setupAria: "Réglages de l'entraînement",
    completeAria: "Exercice terminé",
    difficulty: {
      beginner: {
        label: "Débutant",
        description: "Une règle à appliquer, avec la cible visible sur le plateau.",
      },
      intermediate: {
        label: "Intermédiaire",
        description: "Deux coups liés, ou un choix entre plusieurs coups légaux.",
      },
      advanced: {
        label: "Avancé",
        description:
          "Un plan sur plusieurs coups, où l'ordre ou l'espace libéré compte.",
      },
    },
    categories: {
      tableau: {
        title: "Tableau",
        description:
          "Construire des suites, révéler des cartes cachées et gérer les colonnes vides.",
      },
      foundations: {
        title: "Fondations",
        description:
          "Décider quand une carte va sur une fondation et quand elle sert encore en dessous.",
      },
      "stock-and-waste": {
        title: "Pioche et défausse",
        description:
          "Planifier les tirages, recycler la pioche et utiliser la carte retournée.",
      },
      strategy: {
        title: "Stratégie",
        description: "Comparer les coups selon ce qu'ils révèlent et préparent.",
      },
    },
    skills: {
      "alternating-colors": {
        title: "Couleurs alternées",
        focus:
          "Une carte du tableau doit être de la couleur opposée et d'un rang inférieur.",
        hint1:
          "Compare la couleur de la carte à déplacer avec celle de la carte d'accueil.",
        hint2:
          "Seule la couleur opposée convient, un rang plus bas. Le coup vérifié en montre un placement.",
      },
      "descending-sequences": {
        title: "Suites descendantes",
        focus: "Les suites du tableau descendent d'exactement un rang.",
        hint1: "Compte à rebours depuis la carte sur laquelle tu construis.",
        hint2: "Cherche une carte exactement un rang plus bas que la carte du dessus.",
      },
      "moving-runs": {
        title: "Déplacer des suites",
        focus: "Une suite légale face visible se déplace d'un seul bloc.",
        hint1: "Vérifie si les cartes sous la tête forment déjà une suite légale.",
        hint2:
          "Déplace la tête de la suite sur une cible légale ; les cartes en dessous suivent.",
      },
      "reveal-hidden-cards": {
        title: "Révéler des cartes cachées",
        focus:
          "Retire les cartes face visible au-dessus d'une carte cachée pour la retourner.",
        hint1: "Quelle colonne cache encore une carte sous des cartes face visible ?",
        hint2:
          "Trouve une place légale pour la carte du dessus afin de retourner la carte cachée.",
      },
      "opening-empty-columns": {
        title: "Ouvrir des colonnes vides",
        focus:
          "Seul un Roi, ou une suite commençant par un Roi, peut ouvrir une colonne vide.",
        hint1: "Une colonne vide accueille un Roi ou une suite avec Roi.",
        hint2:
          "Rassemble d'abord le Roi et sa suite, puis déplace le Roi dans la colonne vide.",
      },
      "managing-kings": {
        title: "Gérer les Rois",
        focus:
          "Déplacer un Roi coûte une colonne : prévois ce que la colonne libérée va recevoir.",
        hint1: "Déplacer un Roi libère la colonne qu'il quitte.",
        hint2: "Déplace une suite avec Roi, puis utilise la colonne libérée.",
      },
      "foundation-timing": {
        title: "Timing des fondations",
        focus: "Une fondation se construit à partir de son As, un rang à la fois.",
        hint1: "Une fondation n'accepte que la carte suivante de sa couleur.",
        hint2: "Commence la fondation par l'As ; le rang suivant devient légal ensuite.",
      },
      "keeping-tableau-cards": {
        title: "Garder des cartes au tableau",
        focus:
          "Une carte qui peut encore recevoir une autre carte fait un travail utile au tableau.",
        hint1:
          "Avant de monter une carte, vérifie quelle carte pourrait encore se poser dessus.",
        hint2:
          "Laisse au tableau la carte qui reçoit une autre carte et construis la fondation autour.",
      },
      "efficient-foundations": {
        title: "Fondations efficaces",
        focus: "Chaque carte de fondation rend le rang suivant légal.",
        hint1: "Joue les cartes de fondation dans l'ordre des rangs.",
        hint2: "As, puis deux, puis trois : une carte à la fois.",
      },
      "stock-draw-decisions": {
        title: "Décider un tirage",
        focus: "Un tirage retourne une carte de la pioche dans la défausse.",
        hint1: "Le dessus de la défausse est la seule carte qu'un tirage te donne.",
        hint2:
          "Pioche une fois, puis vérifie si la carte de la défausse a une place légale.",
      },
      "waste-pile-management": {
        title: "Gérer la défausse",
        focus: "Joue depuis la défausse avant de piocher à nouveau.",
        hint1: "Un coup légal depuis la défausse garde le tirage suivant utile.",
        hint2: "Vide la défausse sur le tableau, puis pioche la carte suivante.",
      },
      "stock-cycle-planning": {
        title: "Planifier un cycle de pioche",
        focus:
          "Quand la pioche est vide, un tirage remet la défausse dans la pioche.",
        hint1: "Pioche vide : un tirage recycle la défausse dans l'ordre inverse.",
        hint2: "Fais tout le cycle, puis joue la carte qui revient sur le dessus.",
      },
      "planning-ahead": {
        title: "Planifier à l'avance",
        focus:
          "Vérifie où mène un coup et ce qu'il va révéler avant de le jouer.",
        hint1: "Regarde ce que la colonne révèle quand la carte du dessus part.",
        hint2: "Déplace la carte qui découvre une carte ayant une place légale.",
      },
      "choosing-reveals": {
        title: "Choisir la carte à révéler",
        focus: "Compare ce que chaque carte cachée pourrait débloquer.",
        hint1:
          "Deux colonnes cachent des cartes : quelle carte face visible a une place légale ?",
        hint2: "Retourne la carte cachée dont tu peux dégager la colonne.",
      },
      "avoiding-blocked-positions": {
        title: "Éviter les positions bloquées",
        focus: "Une carte cachée recouverte bloque toute la colonne.",
        hint1: "Trouve la carte face visible qui recouvre une carte cachée.",
        hint2:
          "Déplace la carte qui recouvre vers une cible légale, puis place la carte révélée.",
      },
      "comparing-alternative-moves": {
        title: "Comparer des coups",
        focus: "Deux ordres légaux peuvent mener au même arrangement.",
        hint1: "Les trois mêmes cartes peuvent s'empiler dans les deux ordres.",
        hint2: "Construis la suite étape par étape ; ici l'ordre n'importe pas.",
      },
    },
    exercises: {
      "alternating-colors": {
        title: "Couleurs alternées",
        objective: "Place le 7 de cœur sur le 8 de pique.",
        explanation:
          "Un placement au tableau doit être d'un rang inférieur et de la couleur opposée.",
        success: "Un 7 rouge va sur un 8 noir.",
        rationale: "Une règle, une cible visible, un coup.",
      },
      "alternating-colors-two": {
        title: "Couleurs alternées, enchaînées",
        objective:
          "Construis une suite avec le 9 de pique, le 8 de cœur et le 7 de trèfle.",
        explanation:
          "Chaque carte est d'un rang inférieur à celle du dessus, et les couleurs alternent.",
        success: "Le 8 de trèfle semblait proche, mais il ne pouvait pas aller sur un 9 noir.",
        rationale: "Deux placements liés avec un leurre de même couleur.",
      },
      "descending-sequences": {
        title: "Suites descendantes",
        objective: "Place le 6 de pique sur le 7 de cœur.",
        explanation:
          "Les suites du tableau descendent d'exactement un rang : un 6 va sur un 7.",
        success: "La suite descend d'un rang, comme prévu.",
        rationale: "Une vérification de rang, une cible visible.",
      },
      "moving-runs": {
        title: "Déplacer des suites",
        objective: "Déplace la suite 10, 9, 8 sur le Valet de pique.",
        explanation:
          "Une suite légale face visible se déplace d'un bloc ; ses cartes ne bougent pas une par une.",
        success: "Toute la suite est arrivée ensemble et la colonne d'origine est vide.",
        rationale:
          "Un seul coup, mais il faut reconnaître trois cartes comme une seule suite.",
      },
      "moving-runs-two": {
        title: "Déplacer une suite, puis l'étendre",
        objective:
          "Déplace la suite Dame-Valet sur le Roi de cœur, puis ajoute le 10 de trèfle.",
        explanation:
          "D'abord la suite se déplace d'un bloc, puis le 10 prolonge la nouvelle suite.",
        success:
          "Quatre cartes dans une suite : Dame-Valet ensemble, puis le 10 pour finir.",
        rationale:
          "Deux coups liés aux rôles différents : transporter une suite, puis l'étendre.",
      },
      "reveal-hidden-cards": {
        title: "Révéler des cartes cachées",
        objective: "Révèle la carte face cachée de la première colonne.",
        explanation:
          "Retirer la carte face visible au-dessus d'une carte cachée la retourne.",
        success: "La carte cachée est face visible : son identité est connue.",
        rationale: "Un placement dont l'intérêt est la révélation qu'il provoque.",
      },
      "opening-empty-columns": {
        title: "Ouvrir des colonnes vides",
        objective:
          "Termine avec le Roi de cœur et sa Dame dans la dernière colonne.",
        explanation:
          "Seul un Roi, ou une suite avec Roi, peut ouvrir une colonne vide.",
        success:
          "Le Roi et la Dame occupent la colonne vide et les anciennes colonnes sont libres.",
        rationale:
          "Deux coups dans un ordre libre, tous deux soumis à la règle de la colonne vide.",
      },
      "managing-kings": {
        title: "Gérer les Rois",
        objective:
          "Déplace la suite du Roi de pique vers la colonne vide, puis la suite du Roi de carreau dans la colonne libérée.",
        explanation:
          "Déplacer un Roi coûte une colonne : le plan utile en libère une autre.",
        success:
          "Un Roi déplacé, une colonne libérée, et le second Roi y a trouvé sa place.",
        rationale: "Deux déplacements de Roi où le premier crée l'espace du second.",
      },
      "foundation-timing": {
        title: "Timing des fondations",
        objective: "Place les deux cartes de cœur sur la fondation de cœur.",
        explanation:
          "Une fondation n'accepte que le rang suivant de sa couleur : l'As doit passer d'abord.",
        success: "La fondation se construit dans l'ordre : As, puis deux.",
        rationale:
          "Une règle appliquée deux fois, le second coup n'étant légal qu'après le premier.",
      },
      "keeping-tableau-cards": {
        title: "Garder des cartes au tableau",
        objective:
          "Monte la fondation de cœur jusqu'au deux, mais garde le 3 de cœur pour que le 2 de pique ait encore une place.",
        explanation:
          "Une carte qui peut encore recevoir une autre carte travaille utilement au tableau.",
        success:
          "La fondation a avancé et le 3 de cœur est resté là où il servait.",
        rationale:
          "Trois coups avec un vrai compromis : avancer une fondation sans retirer une cible.",
      },
      "efficient-foundations": {
        title: "Fondations efficaces",
        objective: "Monte la fondation de cœur jusqu'au 3.",
        explanation:
          "Chaque carte de fondation rend le rang suivant légal : l'ordre est fixé.",
        success: "As, deux, trois : chaque carte a débloqué la suivante.",
        rationale:
          "Trois coups ordonnés ; le raisonnement porte sur leur dépendance.",
      },
      "stock-draw-decisions": {
        title: "Décider un tirage",
        objective:
          "Pioche une fois et place la carte tirée depuis la défausse.",
        explanation:
          "Un tirage retourne exactement une carte de la pioche dans la défausse.",
        success:
          "Un tirage, un placement : la carte de la défausse avait une place légale.",
        rationale: "Deux coups, tous deux visibles sur le plateau.",
      },
      "waste-pile-management": {
        title: "Gérer la défausse",
        objective:
          "Pioche, place le 7 de trèfle, puis pioche et place le 6 de carreau sur la même colonne.",
        explanation:
          "Jouer depuis la défausse avant de piocher garde le tirage suivant utilisable sur la même colonne.",
        success:
          "Les deux cartes tirées ont trouvé une place et la défausse est vide.",
        rationale:
          "Quatre coups où jouer la défausse d'abord rend le tirage suivant utile.",
      },
      "stock-cycle-planning": {
        title: "Planifier un cycle de pioche",
        objective:
          "Fais un tour complet de la pioche, puis place le 8 de pique sur le 9 de cœur.",
        explanation:
          "Quand la pioche est vide, un tirage remet la défausse dans la pioche : le cycle complet fait partie du plan.",
        success:
          "Un cycle complet, puis la carte est revenue sur le dessus et a trouvé une place.",
        rationale:
          "Un plan de cinq coups qui ne s'achève qu'après le recyclage de la pioche.",
      },
      "planning-ahead": {
        title: "Planifier à l'avance",
        objective: "Libère le 6 de carreau, puis place-le sur le 7 de trèfle.",
        explanation:
          "Vérifie ce que la colonne révèle avant de bouger : l'intérêt est le second coup.",
        success: "Le 5 a fait de la place, le 6 a été révélé et il avait une place.",
        rationale:
          "Deux coups où le premier ne vaut que pour la révélation qu'il produit.",
      },
      "choosing-reveals": {
        title: "Choisir la carte à révéler",
        objective: "Révèle les deux cartes face cachée.",
        explanation:
          "Compare ce que chaque révélation peut débloquer ; ici les deux 7 visibles ont une cible légale.",
        success: "Les deux cartes cachées sont connues, et l'ordre n'importait pas.",
        rationale:
          "Deux révélations indépendantes ; le joueur compare deux choix légaux.",
      },
      "avoiding-blocked-positions": {
        title: "Éviter les positions bloquées",
        objective:
          "Libère la carte face cachée, puis place-la sur le 9 de carreau.",
        explanation:
          "Une carte cachée recouverte bloque toute la colonne : la carte qui la couvre a besoin d'une place.",
        success: "La colonne bloquée est vide et la carte révélée est en jeu.",
        rationale:
          "Deux coups où la révélation n'est possible que parce que la première carte avait une place légale.",
      },
      "comparing-alternative-moves": {
        title: "Comparer des coups",
        objective:
          "Empile le 7 de cœur, le 6 de pique et le 5 de carreau en une seule suite. Les deux ordres fonctionnent.",
        explanation:
          "Deux ordres légaux mènent au même arrangement ; compare le résultat, pas seulement le premier coup.",
        success: "Les deux ordres ont produit la même suite.",
        rationale:
          "Un plan de deux coups avec deux ordres valides : comparer plutôt que suivre un script.",
      },
    },
  },

  es: {
    kicker: "Práctica independiente",
    title: "Practica una habilidad a la vez.",
    description:
      "Ejercicios cortos sobre tableros preparados, jugados con las reglas reales. La práctica acompaña a los cursos y no cambia tu historial de lecciones ni tus resultados competitivos.",
    setupKicker: "Prepara tu ejercicio",
    setupTitle: "Elige una habilidad y un nivel",
    categoryLabel: "Área de habilidad",
    skillLabel: "Habilidad",
    difficultyLabel: "Dificultad",
    start: "Empezar práctica",
    exerciseCount: "{count} ejercicios",
    exerciseCountOne: "1 ejercicio",
    noExercises: "Todavía no hay ningún ejercicio validado para esta elección.",
    objective: "Objetivo",
    skillFocus: "Qué entrena",
    difficultyReason: "Por qué este nivel",
    hint: "Pista",
    nextHint: "Siguiente pista",
    noMoreHints: "No hay más pistas para este ejercicio. Reinícialo o prueba otro.",
    checkedMove: "Jugar la jugada comprobada",
    checkedMoveNote:
      "Una vía comprobada y legal. Otras jugadas legales también pueden alcanzar el objetivo.",
    restart: "Reiniciar ejercicio",
    feedbackCorrect: "Objetivo avanzado.",
    feedbackComplete: "Objetivo alcanzado.",
    feedbackOffGoal: "Jugada legal, pero el objetivo aún no está alcanzado.",
    feedbackIllegal: "Esa jugada no está permitida aquí.",
    completeTitle: "Ejercicio completado",
    completeLead:
      "Has alcanzado el objetivo. Repetir el mismo ejercicio es lo que convierte el patrón en automático.",
    movesUsed: "Jugadas: {count}",
    hintsUsed: "Pistas: {count}",
    another: "Probar otro ejercicio",
    backToSetup: "Volver a la práctica",
    fromReviewKicker: "Desde tu revisión de partida",
    fromReviewTitle: "Estás practicando una situación vista en una revisión.",
    fromReviewBody:
      "Este ejercicio usa un tablero preparado y validado que enseña la misma idea. Tu partida revisada, su resultado y su análisis no cambian.",
    backToReview: "Volver a la revisión",
    fromReviewProgress:
      "Desde la revisión: {attempts} intentos · {completions} completados",
    progressTitle: "Progreso de la práctica",
    progressEmpty: "Aún no hay intentos en este dispositivo.",
    attempted: "Intentos",
    completed: "Completados",
    successRate: "Tasa de éxito",
    hintTotal: "Pistas",
    exercisesDone: "{completed} de {total} ejercicios completados",
    categoryProgress: "Por área",
    guestNote: "La práctica como invitado se guarda en este dispositivo.",
    accountNote: "La práctica se guarda en este dispositivo para tu cuenta.",
    separateNote:
      "El progreso de la práctica es independiente de los cursos y de los resultados clasificados. Aquí no cambian Elo, trofeos ni niveles.",
    boardAria: "Tablero de práctica",
    setupAria: "Ajustes de práctica",
    completeAria: "Ejercicio completado",
    difficulty: {
      beginner: {
        label: "Principiante",
        description: "Una regla que aplicar, con el objetivo visible en el tablero.",
      },
      intermediate: {
        label: "Intermedio",
        description: "Dos jugadas vinculadas, o una elección entre jugadas legales.",
      },
      advanced: {
        label: "Avanzado",
        description:
          "Un plan de varias jugadas, donde importan el orden o el espacio liberado.",
      },
    },
    categories: {
      tableau: {
        title: "Tableau",
        description:
          "Construir secuencias, revelar cartas ocultas y gestionar columnas vacías.",
      },
      foundations: {
        title: "Fundaciones",
        description:
          "Decidir cuándo una carta va a una fundación y cuándo sigue haciendo falta debajo.",
      },
      "stock-and-waste": {
        title: "Mazo y descarte",
        description:
          "Planificar robadas, reciclar el mazo y usar la carta que volteas.",
      },
      strategy: {
        title: "Estrategia",
        description: "Comparar jugadas por lo que revelan y preparan.",
      },
    },
    skills: {
      "alternating-colors": {
        title: "Colores alternos",
        focus:
          "Una carta del tableau debe ser del color opuesto y un rango menor.",
        hint1:
          "Compara el color de la carta que quieres mover con el de la carta de destino.",
        hint2:
          "Solo encaja el color opuesto, un rango más abajo. La jugada comprobada muestra una colocación.",
      },
      "descending-sequences": {
        title: "Secuencias descendentes",
        focus: "Las secuencias del tableau bajan exactamente un rango.",
        hint1: "Cuenta hacia abajo desde la carta sobre la que construyes.",
        hint2: "Busca una carta exactamente un rango menor que la carta superior.",
      },
      "moving-runs": {
        title: "Mover secuencias",
        focus: "Una secuencia legal boca arriba se mueve como una sola unidad.",
        hint1:
          "Comprueba si las cartas bajo la cabeza ya forman una secuencia legal.",
        hint2:
          "Mueve la cabeza de la secuencia a un destino legal; las cartas de abajo la siguen.",
      },
      "reveal-hidden-cards": {
        title: "Revelar cartas ocultas",
        focus:
          "Retira las cartas boca arriba que cubren una carta boca abajo para voltearla.",
        hint1: "¿Qué columna aún esconde una carta bajo cartas boca arriba?",
        hint2:
          "Encuentra un destino legal para la carta superior y la oculta se volteará.",
      },
      "opening-empty-columns": {
        title: "Abrir columnas vacías",
        focus:
          "Solo un Rey, o una secuencia encabezada por un Rey, puede iniciar una columna vacía.",
        hint1: "Una columna vacía acepta un Rey o una secuencia con Rey.",
        hint2:
          "Reúne primero el Rey y su secuencia, luego mueve el Rey a la columna vacía.",
      },
      "managing-kings": {
        title: "Gestionar Reyes",
        focus:
          "Mover un Rey cuesta una columna: planifica qué recibirá la columna liberada.",
        hint1: "Mover un Rey libera la columna que deja.",
        hint2: "Reubica una secuencia con Rey y luego usa la columna liberada.",
      },
      "foundation-timing": {
        title: "Momento de las fundaciones",
        focus: "Una fundación se construye desde su As, un rango a la vez.",
        hint1: "Una fundación solo acepta la siguiente carta de su palo.",
        hint2: "Empieza la fundación con el As; el siguiente rango será legal después.",
      },
      "keeping-tableau-cards": {
        title: "Mantener cartas en el tableau",
        focus:
          "Una carta que aún puede recibir otra carta hace un trabajo útil en el tableau.",
        hint1:
          "Antes de subir una carta, comprueba qué carta podría colocarse todavía sobre ella.",
        hint2:
          "Deja en el tableau la carta que recibe otra y construye la fundación alrededor.",
      },
      "efficient-foundations": {
        title: "Fundaciones eficientes",
        focus: "Cada carta de fundación hace legal el siguiente rango.",
        hint1: "Juega las cartas de fundación en orden de rango.",
        hint2: "As, luego dos, luego tres: una carta a la vez.",
      },
      "stock-draw-decisions": {
        title: "Decidir una robada",
        focus: "Una robada voltea una carta del mazo al descarte.",
        hint1: "La parte superior del descarte es la única carta que te da una robada.",
        hint2:
          "Roba una vez y comprueba si la carta del descarte tiene un destino legal.",
      },
      "waste-pile-management": {
        title: "Gestionar el descarte",
        focus: "Juega desde el descarte antes de volver a robar.",
        hint1: "Una jugada legal desde el descarte mantiene útil la siguiente robada.",
        hint2: "Vacía la carta del descarte en el tableau y luego roba la siguiente.",
      },
      "stock-cycle-planning": {
        title: "Planificar un ciclo del mazo",
        focus:
          "Cuando el mazo está vacío, una robada devuelve el descarte al mazo.",
        hint1: "Con el mazo vacío, una robada recicla el descarte en orden inverso.",
        hint2: "Da la vuelta completa y luego juega la carta que vuelve arriba.",
      },
      "planning-ahead": {
        title: "Planificar con antelación",
        focus:
          "Comprueba adónde lleva una jugada y qué revelará antes de hacerla.",
        hint1: "Mira qué revela la columna cuando sale la carta superior.",
        hint2: "Mueve la carta que descubre otra con un destino legal.",
      },
      "choosing-reveals": {
        title: "Elegir qué carta revelar",
        focus: "Compara qué podría desbloquear cada carta oculta.",
        hint1:
          "Dos columnas esconden cartas: ¿qué carta boca arriba tiene un destino legal?",
        hint2: "Voltea la carta oculta cuya columna puedas despejar.",
      },
      "avoiding-blocked-positions": {
        title: "Evitar posiciones bloqueadas",
        focus: "Una carta oculta cubierta bloquea toda la columna.",
        hint1: "Encuentra la carta boca arriba que cubre una carta oculta.",
        hint2:
          "Mueve la carta que cubre a un destino legal y luego coloca la revelada.",
      },
      "comparing-alternative-moves": {
        title: "Comparar jugadas",
        focus: "Dos órdenes legales pueden llegar a la misma disposición.",
        hint1: "Las mismas tres cartas pueden apilarse en cualquiera de los dos órdenes.",
        hint2: "Construye la secuencia paso a paso; aquí el orden no importa.",
      },
    },
    exercises: {
      "alternating-colors": {
        title: "Colores alternos",
        objective: "Coloca el 7 de corazones sobre el 8 de picas.",
        explanation:
          "Una colocación en el tableau debe ser un rango menor y del color opuesto.",
        success: "Un 7 rojo va sobre un 8 negro.",
        rationale: "Una regla, un destino visible, una jugada.",
      },
      "alternating-colors-two": {
        title: "Colores alternos, encadenados",
        objective:
          "Construye una secuencia con el 9 de picas, el 8 de corazones y el 7 de tréboles.",
        explanation:
          "Cada carta es un rango menor que la de arriba y los colores alternan.",
        success: "El 8 de tréboles parecía cercano, pero no podía ir sobre un 9 negro.",
        rationale: "Dos colocaciones vinculadas con un señuelo del mismo color.",
      },
      "descending-sequences": {
        title: "Secuencias descendentes",
        objective: "Coloca el 6 de picas sobre el 7 de corazones.",
        explanation:
          "Las secuencias del tableau bajan exactamente un rango: un 6 va sobre un 7.",
        success: "La secuencia baja un rango, como debe ser.",
        rationale: "Una comprobación de rango, un destino visible.",
      },
      "moving-runs": {
        title: "Mover secuencias",
        objective: "Mueve la secuencia 10, 9, 8 sobre la J de picas.",
        explanation:
          "Una secuencia legal boca arriba se mueve como una unidad; sus cartas no van una a una.",
        success: "Toda la secuencia llegó junta y la columna de origen quedó vacía.",
        rationale:
          "Una sola jugada, pero hay que reconocer tres cartas como una secuencia.",
      },
      "moving-runs-two": {
        title: "Mover una secuencia y ampliarla",
        objective:
          "Mueve la secuencia Q-J sobre el Rey de corazones y luego añade el 10 de tréboles.",
        explanation:
          "Primero la secuencia se mueve como unidad; después el 10 amplía la nueva secuencia.",
        success: "Cuatro cartas en una secuencia: Q-J juntas y el 10 para completarla.",
        rationale:
          "Dos jugadas vinculadas con roles distintos: transportar una secuencia y ampliarla.",
      },
      "reveal-hidden-cards": {
        title: "Revelar cartas ocultas",
        objective: "Revela la carta boca abajo de la primera columna.",
        explanation:
          "Retirar la carta boca arriba sobre una carta oculta la voltea.",
        success: "La carta oculta está boca arriba: ya se conoce su identidad.",
        rationale: "Una colocación cuyo objetivo es la revelación que provoca.",
      },
      "opening-empty-columns": {
        title: "Abrir columnas vacías",
        objective:
          "Termina con el Rey de corazones y su Reina en la última columna.",
        explanation:
          "Solo un Rey, o una secuencia con Rey, puede iniciar una columna vacía.",
        success:
          "El Rey y la Reina ocupan la columna vacía y las antiguas quedan libres.",
        rationale:
          "Dos jugadas en cualquier orden, ambas sujetas a la regla de la columna vacía.",
      },
      "managing-kings": {
        title: "Gestionar Reyes",
        objective:
          "Mueve la secuencia del Rey de picas a la columna vacía y luego la del Rey de diamantes a la columna liberada.",
        explanation: "Mover un Rey cuesta una columna: el plan útil libera otra.",
        success: "Un Rey movido, una columna liberada y el segundo Rey con sitio.",
        rationale:
          "Dos reubicaciones de Rey donde la primera crea el espacio que necesita la segunda.",
      },
      "foundation-timing": {
        title: "Momento de las fundaciones",
        objective: "Coloca las dos cartas de corazones en la fundación de corazones.",
        explanation:
          "Una fundación solo acepta el siguiente rango de su palo, así que el As debe ir primero.",
        success: "La fundación se construye en orden: As y luego dos.",
        rationale:
          "Una regla aplicada dos veces, con la segunda jugada legal solo después de la primera.",
      },
      "keeping-tableau-cards": {
        title: "Mantener cartas en el tableau",
        objective:
          "Sube la fundación de corazones hasta el dos, pero mantén el 3 de corazones para que el 2 de picas aún tenga sitio.",
        explanation:
          "Una carta que todavía puede recibir otra hace un trabajo útil en el tableau.",
        success: "La fundación avanzó y el 3 de corazones se quedó donde hacía falta.",
        rationale:
          "Tres jugadas con un equilibrio real: avanzar una fundación sin quitar un destino.",
      },
      "efficient-foundations": {
        title: "Fundaciones eficientes",
        objective: "Sube la fundación de corazones hasta el 3.",
        explanation:
          "Cada carta de fundación hace legal el siguiente rango, así que el orden es fijo.",
        success: "As, dos, tres: cada carta desbloqueó la siguiente.",
        rationale:
          "Tres jugadas ordenadas; el razonamiento está en su dependencia.",
      },
      "stock-draw-decisions": {
        title: "Decidir una robada",
        objective: "Roba una vez y coloca la carta robada desde el descarte.",
        explanation:
          "Una robada voltea exactamente una carta del mazo al descarte.",
        success:
          "Una robada, una colocación: la carta del descarte tenía un destino legal.",
        rationale: "Dos jugadas, ambas visibles en el tablero.",
      },
      "waste-pile-management": {
        title: "Gestionar el descarte",
        objective:
          "Roba, coloca el 7 de tréboles y luego roba y coloca el 6 de diamantes en la misma columna.",
        explanation:
          "Jugar desde el descarte antes de volver a robar mantiene útil la siguiente robada en la misma columna.",
        success:
          "Las dos cartas robadas encontraron sitio y el descarte quedó vacío.",
        rationale:
          "Cuatro jugadas donde jugar el descarte primero hace útil la siguiente robada.",
      },
      "stock-cycle-planning": {
        title: "Planificar un ciclo del mazo",
        objective:
          "Da una vuelta completa al mazo y luego coloca el 8 de picas sobre el 9 de corazones.",
        explanation:
          "Cuando el mazo está vacío, una robada devuelve el descarte al mazo: el ciclo completo forma parte del plan.",
        success:
          "Un ciclo completo, luego la carta volvió arriba y encontró sitio.",
        rationale:
          "Un plan de cinco jugadas que solo se completa tras reciclar el mazo.",
      },
      "planning-ahead": {
        title: "Planificar con antelación",
        objective: "Libera el 6 de diamantes y colócalo sobre el 7 de tréboles.",
        explanation:
          "Comprueba qué revela la columna antes de mover: lo importante es la segunda jugada.",
        success: "El 5 hizo sitio, el 6 se reveló y tenía destino.",
        rationale:
          "Dos jugadas donde la primera solo vale por la revelación que produce.",
      },
      "choosing-reveals": {
        title: "Elegir qué carta revelar",
        objective: "Revela las dos cartas boca abajo.",
        explanation:
          "Compara qué puede desbloquear cada revelación; aquí los dos 7 visibles tienen destino legal.",
        success: "Las dos cartas ocultas se conocen y el orden no importó.",
        rationale:
          "Dos revelaciones independientes; el jugador compara dos opciones legales.",
      },
      "avoiding-blocked-positions": {
        title: "Evitar posiciones bloqueadas",
        objective:
          "Libera la carta boca abajo y colócala sobre el 9 de diamantes.",
        explanation:
          "Una carta oculta cubierta bloquea toda la columna: la carta que la cubre necesita destino.",
        success: "La columna bloqueada quedó vacía y la carta revelada está en juego.",
        rationale:
          "Dos jugadas donde la revelación solo es posible porque la primera carta tenía destino legal.",
      },
      "comparing-alternative-moves": {
        title: "Comparar jugadas",
        objective:
          "Apila el 7 de corazones, el 6 de picas y el 5 de diamantes en una secuencia. Sirve cualquier orden.",
        explanation:
          "Dos órdenes legales llegan a la misma disposición; compara el resultado, no solo la primera jugada.",
        success: "Cualquier orden produjo la misma secuencia.",
        rationale:
          "Un plan de dos jugadas con dos órdenes válidos: comparar en lugar de seguir un guion.",
      },
    },
  },
};

export default LEARN_PRACTICE_TRANSLATIONS;
