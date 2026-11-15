// src/lib/learnPhaseTranslations.js
//
// New teaching copy for the 20 existing lessons: the shared independent-practice
// instruction and one short knowledge check per lesson. Learn, Watch, Practice
// feedback and Recap copy reuse the already-localized curriculum keys.

export const LEARN_PHASE_TRANSLATIONS = {
  en: {
    practiceInstruction:
      "Make the best legal move you can see. The answer is not shown; open a hint only if you want one.",
    quiz: {
      "tableau-basics": {
        question: "What makes a tableau placement legal?",
        correct: "One rank lower and the opposite colour.",
        wrong: "Any lower rank, regardless of colour.",
        explanation:
          "Tableau runs descend by one rank and alternate colour. Both conditions are required.",
      },
      "first-draw": {
        question: "What does drawing from the stock do?",
        correct: "It turns one card face up into the waste.",
        wrong: "It sends the top card straight to a foundation.",
        explanation:
          "The stock feeds the waste. From the waste you can then play to the tableau or a foundation.",
      },
      "building-foundations": {
        question: "Which card starts a foundation?",
        correct: "The Ace of that suit.",
        wrong: "Any card of that suit.",
        explanation:
          "Each foundation begins with its Ace and then builds upward in the same suit.",
      },
      "legal-moves": {
        question: "A move is legal. Does that make it the best move?",
        correct: "No: compare what it exposes or sets up next.",
        wrong: "Yes: every legal move is equally useful.",
        explanation:
          "Legality only means the rules allow it. Good play also considers hidden cards, empty columns and future builds.",
      },
      "alternating-colors": {
        question: "Which card can be placed on a black 8?",
        correct: "A red 7.",
        wrong: "A black 7.",
        explanation:
          "Tableau runs alternate colour and descend by one rank, so a red 7 fits a black 8.",
      },
      "descending-sequences": {
        question: "What order does a tableau run follow?",
        correct: "Descending by one rank with alternating colours.",
        wrong: "Ascending by one rank in the same suit.",
        explanation:
          "Runs descend, and each card must be the opposite colour of the card above it.",
      },
      "moving-runs": {
        question: "When you move the head of a legal face-up run, what moves?",
        correct: "The whole run moves together.",
        wrong: "Only the head card moves.",
        explanation:
          "A legal face-up sequence is moved as one unit; splitting it would break the run.",
      },
      "reveal-a-card": {
        question: "Why is revealing a face-down card valuable?",
        correct: "It gives you information and new playable options.",
        wrong: "It always adds a card to a foundation.",
        explanation:
          "A hidden card cannot be used. Revealing it can open a new move, even when the move itself seems small.",
      },
      "opening-columns": {
        question: "Which card may start an empty tableau column?",
        correct: "A King, or a run headed by a King.",
        wrong: "Any card, as long as the column is empty.",
        explanation:
          "Empty columns are for Kings and King-headed runs. Other cards need a legal card above them.",
      },
      "moving-kings": {
        question: "When is moving a King usually worth considering?",
        correct: "When it exposes a useful card or opens a better build.",
        wrong: "Whenever any empty column exists.",
        explanation:
          "A King move costs a column. It is strongest when what it uncovers or enables is worth that space.",
      },
      "choosing-sequences": {
        question: "Two moves are legal and both look reasonable. What should you compare?",
        correct: "What each move exposes or sets up next.",
        wrong: "Only which move uses the higher card.",
        explanation:
          "Look past the first move. The better choice usually creates a stronger next position.",
      },
      "blocked-columns": {
        question: "A column is blocked by a face-down card. What usually helps?",
        correct: "Moving the face-up cards above it to legal targets.",
        wrong: "Drawing until the stock is empty.",
        explanation:
          "You clear a blocked column by finding homes for the cards covering the hidden card.",
      },
      "foundation-timing": {
        question: "Why can moving a card to a foundation be premature?",
        correct: "That card may be more useful as a tableau build target.",
        wrong: "Foundation moves are illegal until the stock is empty.",
        explanation:
          "Foundation progress is useful, but sending a card away can remove a target you still need in the tableau.",
      },
      "keeping-tableau-cards": {
        question: "Why might you keep a low card in the tableau?",
        correct: "It may be the target that lets you build or reveal a card.",
        wrong: "Low cards can never be moved to a foundation.",
        explanation:
          "Keep a card when its tableau role is worth more than the foundation progress it would give you.",
      },
      "low-value-cards": {
        question: "What is the trade-off when sending a low card to a foundation?",
        correct: "Foundation progress versus losing a tableau build target.",
        wrong: "It always blocks that foundation forever.",
        explanation:
          "The move is legal and often useful, but check whether the card is still needed below a run.",
      },
      "efficient-foundations": {
        question: "What makes a foundation sequence efficient?",
        correct: "Each move unlocks the next useful card or move.",
        wrong: "Sending every legal card as soon as possible.",
        explanation:
          "Efficiency is about the position after the move, not simply the number of foundation cards.",
      },
      "planning-ahead": {
        question: "What should you check before playing a sequence of moves?",
        correct: "Where the run will end and what it will expose.",
        wrong: "Only whether the first move is legal.",
        explanation:
          "Plan the destination and the reveal, not just the first card placement.",
      },
      "choosing-reveals": {
        question: "Two moves both reveal a card. What else matters?",
        correct: "Which revealed card creates the better next move.",
        wrong: "Which move is quicker to perform.",
        explanation:
          "Compare the value of the revealed cards and the moves they make available.",
      },
      "stock-cycles": {
        question: "Why might you delay drawing from the stock?",
        correct: "A tableau move may improve the position first.",
        wrong: "Drawing is always a mistake.",
        explanation:
          "Drawing is not bad, but exhausting the stock early removes a resource. Use tableau moves when they clearly improve the board.",
      },
      "difficult-positions": {
        question: "What is a good first step in a low-option position?",
        correct: "Scan for moves that reveal or free a card.",
        wrong: "Make any legal move as quickly as possible.",
        explanation:
          "When options are scarce, prioritise moves that create new information or open space.",
      },
    },
  },
  fr: {
    practiceInstruction:
      "Fais le meilleur coup légal que tu vois. La réponse n'est pas affichée ; ouvre un indice seulement si tu le souhaites.",
    quiz: {
      "tableau-basics": {
        question: "Qu'est-ce qui rend un placement au tableau légal ?",
        correct: "Un rang de moins et la couleur opposée.",
        wrong: "N'importe quel rang plus bas, quelle que soit la couleur.",
        explanation:
          "Une suite du tableau descend d'un rang et alterne les couleurs. Les deux conditions sont nécessaires.",
      },
      "first-draw": {
        question: "Que fait un tirage de la pioche ?",
        correct: "Il retourne une carte face visible dans la défausse.",
        wrong: "Il envoie directement la carte du dessus sur une fondation.",
        explanation:
          "La pioche alimente la défausse. Depuis la défausse, tu peux ensuite jouer au tableau ou sur une fondation.",
      },
      "building-foundations": {
        question: "Quelle carte commence une fondation ?",
        correct: "L'As de cette couleur.",
        wrong: "N'importe quelle carte de cette couleur.",
        explanation:
          "Chaque fondation commence par son As, puis monte dans la même couleur.",
      },
      "legal-moves": {
        question: "Un coup est légal. Est-ce forcément le meilleur coup ?",
        correct: "Non : compare ce qu'il révèle ou prépare ensuite.",
        wrong: "Oui : tous les coups légaux sont également utiles.",
        explanation:
          "La légalité signifie seulement que les règles l'autorisent. Le bon jeu tient aussi compte des cartes cachées, des colonnes vides et des suites futures.",
      },
      "alternating-colors": {
        question: "Quelle carte peut aller sur un 8 noir ?",
        correct: "Un 7 rouge.",
        wrong: "Un 7 noir.",
        explanation:
          "Les suites alternent les couleurs et descendent d'un rang : un 7 rouge convient sur un 8 noir.",
      },
      "descending-sequences": {
        question: "Quel ordre suit une suite du tableau ?",
        correct: "Descendant d'un rang, avec des couleurs alternées.",
        wrong: "Montant d'un rang, dans la même couleur.",
        explanation:
          "Les suites descendent, et chaque carte doit être de la couleur opposée à celle du dessus.",
      },
      "moving-runs": {
        question: "Quand tu déplaces la tête d'une suite légale face visible, que se déplace ?",
        correct: "Toute la suite se déplace ensemble.",
        wrong: "Seule la carte de tête se déplace.",
        explanation:
          "Une suite légale face visible se déplace comme un tout ; la séparer briserait la suite.",
      },
      "reveal-a-card": {
        question: "Pourquoi révéler une carte face cachée est-il utile ?",
        correct: "Cela donne des informations et de nouvelles options.",
        wrong: "Cela ajoute toujours une carte à une fondation.",
        explanation:
          "Une carte cachée ne peut pas être utilisée. La révéler peut ouvrir un nouveau coup, même si le déplacement semble secondaire.",
      },
      "opening-columns": {
        question: "Quelle carte peut commencer une colonne vide du tableau ?",
        correct: "Un Roi, ou une suite commençant par un Roi.",
        wrong: "N'importe quelle carte, tant que la colonne est vide.",
        explanation:
          "Les colonnes vides accueillent les Rois et les suites commençant par un Roi. Les autres cartes ont besoin d'une carte légale au-dessus.",
      },
      "moving-kings": {
        question: "Quand déplacer un Roi vaut-il souvent la peine ?",
        correct: "Quand cela révèle une carte utile ou ouvre une meilleure suite.",
        wrong: "Dès qu'une colonne vide existe.",
        explanation:
          "Déplacer un Roi coûte une colonne. C'est plus fort quand ce qu'il découvre ou permet vaut cet espace.",
      },
      "choosing-sequences": {
        question: "Deux coups sont légaux et semblent raisonnables. Que comparer ?",
        correct: "Ce que chaque coup révèle ou prépare ensuite.",
        wrong: "Seulement lequel utilise la carte la plus haute.",
        explanation:
          "Regarde au-delà du premier coup. Le meilleur choix crée généralement une position suivante plus forte.",
      },
      "blocked-columns": {
        question: "Une colonne est bloquée par une carte face cachée. Qu'est-ce qui aide souvent ?",
        correct: "Déplacer les cartes face visible au-dessus vers des cibles légales.",
        wrong: "Piocher jusqu'à vider la pioche.",
        explanation:
          "On libère une colonne bloquée en trouvant une place aux cartes qui recouvrent la carte cachée.",
      },
      "foundation-timing": {
        question: "Pourquoi monter une carte sur une fondation peut-il être prématuré ?",
        correct: "Cette carte peut être plus utile comme cible de construction au tableau.",
        wrong: "Les coups de fondation sont interdits tant que la pioche n'est pas vide.",
        explanation:
          "La progression des fondations est utile, mais retirer une carte peut supprimer une cible encore nécessaire au tableau.",
      },
      "keeping-tableau-cards": {
        question: "Pourquoi garder une petite carte au tableau ?",
        correct: "Elle peut être la cible qui permet de construire ou de révéler une carte.",
        wrong: "Les petites cartes ne peuvent jamais aller sur une fondation.",
        explanation:
          "Garde une carte quand son rôle au tableau vaut plus que la progression de fondation qu'elle apporterait.",
      },
      "low-value-cards": {
        question: "Quel est le compromis quand on envoie une petite carte sur une fondation ?",
        correct: "La progression de fondation contre la perte d'une cible au tableau.",
        wrong: "Cela bloque toujours cette fondation définitivement.",
        explanation:
          "Le coup est légal et souvent utile, mais vérifie si la carte sert encore sous une suite.",
      },
      "efficient-foundations": {
        question: "Qu'est-ce qui rend une suite de fondations efficace ?",
        correct: "Chaque coup débloque la carte ou le coup utile suivant.",
        wrong: "Envoyer toutes les cartes légales le plus vite possible.",
        explanation:
          "L'efficacité se juge sur la position après le coup, pas seulement sur le nombre de cartes montées.",
      },
      "planning-ahead": {
        question: "Que vérifier avant de jouer une suite de coups ?",
        correct: "Où la suite va se terminer et ce qu'elle va révéler.",
        wrong: "Seulement si le premier coup est légal.",
        explanation:
          "Planifie la destination et la révélation, pas seulement le premier placement.",
      },
      "choosing-reveals": {
        question: "Deux coups révèlent une carte. Quoi d'autre compte ?",
        correct: "Quelle carte révélée crée le meilleur coup suivant.",
        wrong: "Quel coup est le plus rapide à jouer.",
        explanation:
          "Compare la valeur des cartes révélées et les coups qu'elles rendent possibles.",
      },
      "stock-cycles": {
        question: "Pourquoi retarder parfois un tirage de la pioche ?",
        correct: "Un coup au tableau peut d'abord améliorer la position.",
        wrong: "Piocher est toujours une erreur.",
        explanation:
          "Piocher n'est pas mauvais, mais épuiser la pioche tôt retire une ressource. Utilise les coups du tableau quand ils améliorent clairement le jeu.",
      },
      "difficult-positions": {
        question: "Quel est un bon premier réflexe dans une position avec peu d'options ?",
        correct: "Chercher les coups qui révèlent ou libèrent une carte.",
        wrong: "Jouer n'importe quel coup légal le plus vite possible.",
        explanation:
          "Quand les options sont rares, privilégie les coups qui créent de l'information ou ouvrent de l'espace.",
      },
    },
  },
  es: {
    practiceInstruction:
      "Haz la mejor jugada legal que veas. La respuesta no se muestra; abre una pista solo si quieres.",
    quiz: {
      "tableau-basics": {
        question: "¿Qué hace legal una colocación en el tableau?",
        correct: "Un rango menos y el color opuesto.",
        wrong: "Cualquier rango más bajo, sea cual sea el color.",
        explanation:
          "Las secuencias del tableau bajan un rango y alternan colores. Se necesitan ambas condiciones.",
      },
      "first-draw": {
        question: "¿Qué hace robar del mazo?",
        correct: "Voltea una carta boca arriba al descarte.",
        wrong: "Envía la carta superior directamente a una fundación.",
        explanation:
          "El mazo alimenta el descarte. Desde el descarte puedes jugar al tableau o a una fundación.",
      },
      "building-foundations": {
        question: "¿Qué carta inicia una fundación?",
        correct: "El As de ese palo.",
        wrong: "Cualquier carta de ese palo.",
        explanation:
          "Cada fundación empieza con su As y después sube en el mismo palo.",
      },
      "legal-moves": {
        question: "Una jugada es legal. ¿Eso la convierte en la mejor?",
        correct: "No: compara qué revela o prepara después.",
        wrong: "Sí: toda jugada legal es igual de útil.",
        explanation:
          "La legalidad solo significa que las reglas la permiten. El buen juego también considera cartas ocultas, columnas vacías y secuencias futuras.",
      },
      "alternating-colors": {
        question: "¿Qué carta puede colocarse sobre un 8 negro?",
        correct: "Un 7 rojo.",
        wrong: "Un 7 negro.",
        explanation:
          "Las secuencias alternan colores y bajan un rango, así que un 7 rojo encaja sobre un 8 negro.",
      },
      "descending-sequences": {
        question: "¿Qué orden sigue una secuencia del tableau?",
        correct: "Descendente de uno en uno y con colores alternos.",
        wrong: "Ascendente de uno en uno y del mismo palo.",
        explanation:
          "Las secuencias bajan y cada carta debe ser del color opuesto a la de arriba.",
      },
      "moving-runs": {
        question: "Al mover la cabeza de una secuencia legal boca arriba, ¿qué se mueve?",
        correct: "Toda la secuencia se mueve junta.",
        wrong: "Solo se mueve la carta de la cabeza.",
        explanation:
          "Una secuencia legal boca arriba se mueve como una unidad; separarla rompería la secuencia.",
      },
      "reveal-a-card": {
        question: "¿Por qué es valioso revelar una carta boca abajo?",
        correct: "Da información y nuevas opciones de juego.",
        wrong: "Siempre añade una carta a una fundación.",
        explanation:
          "Una carta oculta no se puede usar. Revelarla puede abrir una jugada nueva, aunque el movimiento parezca pequeño.",
      },
      "opening-columns": {
        question: "¿Qué carta puede iniciar una columna vacía del tableau?",
        correct: "Un Rey, o una secuencia encabezada por un Rey.",
        wrong: "Cualquier carta, si la columna está vacía.",
        explanation:
          "Las columnas vacías son para Reyes y secuencias con Rey. Las demás cartas necesitan una carta legal encima.",
      },
      "moving-kings": {
        question: "¿Cuándo suele valer la pena mover un Rey?",
        correct: "Cuando revela una carta útil o abre una mejor construcción.",
        wrong: "Siempre que exista una columna vacía.",
        explanation:
          "Mover un Rey cuesta una columna. Es más fuerte cuando lo que descubre o permite vale ese espacio.",
      },
      "choosing-sequences": {
        question: "Dos jugadas son legales y parecen razonables. ¿Qué comparar?",
        correct: "Qué revela o prepara cada una después.",
        wrong: "Solo cuál usa la carta más alta.",
        explanation:
          "Mira más allá de la primera jugada. La mejor elección suele crear una posición siguiente más fuerte.",
      },
      "blocked-columns": {
        question: "Una columna está bloqueada por una carta boca abajo. ¿Qué suele ayudar?",
        correct: "Mover las cartas boca arriba de encima a destinos legales.",
        wrong: "Robar hasta vaciar el mazo.",
        explanation:
          "Se desbloquea una columna encontrando destino a las cartas que cubren la carta oculta.",
      },
      "foundation-timing": {
        question: "¿Por qué puede ser prematuro mover una carta a una fundación?",
        correct: "Esa carta puede ser más útil como objetivo de construcción en el tableau.",
        wrong: "Las jugadas a fundación son ilegales hasta vaciar el mazo.",
        explanation:
          "El progreso de la fundación es útil, pero quitar una carta puede eliminar un objetivo que aún necesitas en el tableau.",
      },
      "keeping-tableau-cards": {
        question: "¿Por qué podrías mantener una carta baja en el tableau?",
        correct: "Puede ser el objetivo que te permite construir o revelar una carta.",
        wrong: "Las cartas bajas nunca pueden ir a una fundación.",
        explanation:
          "Mantén una carta cuando su papel en el tableau vale más que el progreso de fundación que daría.",
      },
      "low-value-cards": {
        question: "¿Cuál es el equilibrio al enviar una carta baja a una fundación?",
        correct: "Progreso de fundación frente a perder un objetivo de construcción.",
        wrong: "Siempre bloquea esa fundación para siempre.",
        explanation:
          "La jugada es legal y a menudo útil, pero comprueba si la carta aún hace falta bajo una secuencia.",
      },
      "efficient-foundations": {
        question: "¿Qué hace eficiente una secuencia de fundaciones?",
        correct: "Cada jugada desbloquea la siguiente carta o jugada útil.",
        wrong: "Enviar todas las cartas legales lo antes posible.",
        explanation:
          "La eficiencia se juzga por la posición después de la jugada, no solo por cuántas cartas subiste.",
      },
      "planning-ahead": {
        question: "¿Qué comprobar antes de jugar una secuencia de movimientos?",
        correct: "Dónde terminará la secuencia y qué revelará.",
        wrong: "Solo si la primera jugada es legal.",
        explanation:
          "Planifica el destino y la revelación, no solo la primera colocación.",
      },
      "choosing-reveals": {
        question: "Dos jugadas revelan una carta. ¿Qué más importa?",
        correct: "Qué carta revelada crea la mejor jugada siguiente.",
        wrong: "Qué jugada es más rápida de hacer.",
        explanation:
          "Compara el valor de las cartas reveladas y las jugadas que permiten.",
      },
      "stock-cycles": {
        question: "¿Por qué podrías retrasar una robada del mazo?",
        correct: "Una jugada del tableau puede mejorar antes la posición.",
        wrong: "Robar siempre es un error.",
        explanation:
          "Robar no es malo, pero agotar el mazo pronto quita un recurso. Usa jugadas del tableau cuando mejoran claramente el tablero.",
      },
      "difficult-positions": {
        question: "¿Cuál es un buen primer paso en una posición con pocas opciones?",
        correct: "Buscar jugadas que revelen o liberen una carta.",
        wrong: "Hacer cualquier jugada legal lo más rápido posible.",
        explanation:
          "Cuando hay pocas opciones, prioriza las jugadas que crean información o abren espacio.",
      },
    },
  },
};
