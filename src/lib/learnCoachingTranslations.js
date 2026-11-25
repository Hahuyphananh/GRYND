// src/lib/learnCoachingTranslations.js
//
// Copy for GRYND Pro advanced coaching. Mounted at `learn.coaching` in
// learnTranslations.js, so components keep using `t("learn.coaching...")`.
//
// The copy explains what coaching does, why it helps and what extra information
// it shows. It never claims a move was a mistake: the record can only support
// attempts, completions, hints and unfinished drills.

export const LEARN_COACHING_TRANSLATIONS = {
  en: {
    kicker: "GRYND Pro · Academy coaching",
    title: "Advanced coaching",
    description:
      "Coaching reads the practice and lesson record saved on this device and turns it into analytics, targeted recommendations and a short daily plan. It never invents a weakness and never sends your learning data anywhere else.",
    proBadge: "Pro",
    loading: "Reading your learning record…",
    errorTitle: "Your coaching report could not be loaded",
    errorBody:
      "Your learning progress is safe on this device. Nothing was lost — try again in a moment.",
    retry: "Try again",
    updated: "Updated {time}",
    privacy:
      "Only the Academy record saved on this device is used: lessons completed, practice attempts, completions and hints. No match, opponent or hidden-card data is read, and no AI service analyses your play.",
    backToPractice: "Back to Practice",
    guest: {
      title: "Sign in to open coaching",
      body:
        "Coaching is part of GRYND Pro. Sign in to check your membership — your current lesson and practice progress stays on this device.",
      cta: "Sign in",
      free:
        "All five courses, every lesson, the videos and basic practice stay free and need no account.",
    },
    locked: {
      title: "Coaching is part of GRYND Pro",
      body:
        "Advanced coaching turns your own practice record into a plan. Everything you need to learn Solitaire stays free.",
      whatTitle: "What it does",
      what:
        "It builds a private analytics view of your practice, finds the skills the numbers actually support as weaker, and suggests the next drills and the lesson that teaches them.",
      whyTitle: "Why it helps",
      why:
        "You stop guessing what to practise. The plan points at a specific skill, the right difficulty and a session you can finish in a few minutes.",
      extraTitle: "What you see that free practice does not",
      extra:
        "Success rate by skill and by difficulty, hint usage, progress over time, week-to-week comparisons and a daily plan.",
      point1: "Success rate by skill and by difficulty.",
      point2: "Hint usage and how it changes your results.",
      point3: "Progress over time, with comparisons only when there is enough history.",
      point4: "A deterministic daily plan built from your own attempts.",
      cta: "See GRYND Pro",
      note:
        "Nothing you need to learn the game is locked: all five courses, all 20 lessons, demonstrations, curriculum exercises, hints, knowledge checks, videos and basic practice remain free.",
    },
    unavailable: {
      title: "We cannot check your membership right now",
      body:
        "This is a temporary connection problem, not a change to your subscription. Your learning progress is untouched. Try again in a moment.",
    },
    totals: {
      lessons: "Lessons completed",
      lessonsSub: "{completed} of {total} lessons",
      exercises: "Exercises completed",
      exercisesSub: "{completed} of {attempted} attempted",
      success: "Practice success",
      hints: "Hints used",
      practiceSub: "{attempts} attempts",
    },
    skills: {
      title: "Success by skill",
      note:
        "Only skills you have practised appear here. A skill needs at least {min} attempts before coaching treats it as a weak area.",
      empty:
        "No skill data yet. Finish a drill in Practice and it will appear here.",
      skill: "Skill",
      attempts: "Attempts",
      completions: "Completed",
      success: "Success",
      hints: "Hints",
    },
    difficulties: {
      title: "Success by difficulty",
      note: "How your results change as the drills get harder.",
      empty: "No difficulty data yet.",
      level: "Difficulty",
    },
    history: {
      title: "Progress over time",
      note: "Practice activity recorded on this device, by day.",
      empty:
        "Not enough days recorded yet. Your history builds as you practise.",
      legend: "Bars show attempts; the brighter part shows completions.",
    },
    comparison: {
      title: "Week to week",
      note: "Only shown when both weeks have at least {min} attempts.",
      current: "Last 7 days",
      previous: "Previous 7 days",
      success: "Success rate",
      attempts: "Attempts",
      hints: "Hints",
      delta: "Change",
      notEnough:
        "Not enough history for a fair comparison yet. Keep practising — coaching needs two weeks with a few attempts in each.",
    },
    weak: {
      title: "Areas to improve",
      note:
        "Based on your recorded attempts, completions and hints — not on a single move.",
      none:
        "No weak area is supported by the data right now. That is a good sign, not a missing report.",
      lowSuccess: "Success rate is below {rate}% across {attempts} attempts.",
      hintReliance:
        "You used at least one hint per attempt ({hints} hints for {attempts} attempts).",
      unfinished: "{unfinished} of {attempts} attempts were not completed.",
      practice: "Practise this skill",
    },
    recommendations: {
      title: "Recommended next",
      note:
        "Each suggestion comes from a recorded result. Nothing here is generated by an AI model.",
      resumeLesson: "You started this lesson but have not finished it.",
      lowSuccess: "This skill is the clearest gap in your practice record.",
      hintReliance:
        "Hints are carrying this skill; a short drill can make it independent.",
      unfinished:
        "This skill has unfinished attempts worth repeating.",
      readyForNextLevel:
        "Your results here are strong enough for a harder drill.",
      openPractice: "Open drill",
      openLesson: "Open lesson",
      empty:
        "No recommendation yet. Coaching only suggests something when your record supports it.",
    },
    plan: {
      title: "Your daily plan",
      note:
        "A short, deterministic session built from the same record. No new content, no random picks.",
      focus: "Focus skill",
      difficulty: "Difficulty",
      lesson: "Lesson to revisit",
      daily: "Daily session",
      minutes: "{count} min",
      unavailable: "No plan yet",
      noPracticeData:
        "Finish a few practice drills and a plan will appear here.",
      notEnoughData:
        "There is not enough recorded practice to build a plan yet.",
      focusWeakSkill:
        "Built around the skill your record shows needs the most work.",
      resumeLesson: "Built around the lesson you already started.",
      itemPractice: "Drill: {title}",
      itemLesson: "Lesson: {title}",
      start: "Start with this skill",
    },
    practiceEntry: {
      title: "GRYND Pro coaching",
      body:
        "Turn your practice record into analytics, targeted drills and a short daily plan.",
      cta: "Open coaching",
      badge: "Pro",
    },
  },

  fr: {
    kicker: "GRYND Pro · Coach de l'Académie",
    title: "Coaching avancé",
    description:
      "Le coaching lit le bilan d'entraînement et de leçons enregistré sur cet appareil et le transforme en analyses, recommandations ciblées et court plan quotidien. Il n'invente jamais de faiblesse et n'envoie tes données d'apprentissage nulle part ailleurs.",
    proBadge: "Pro",
    loading: "Lecture de ton bilan d'apprentissage…",
    errorTitle: "Impossible de charger ton bilan de coaching",
    errorBody:
      "Ta progression est intacte sur cet appareil. Rien n'a été perdu — réessaie dans un instant.",
    retry: "Réessayer",
    updated: "Mis à jour à {time}",
    privacy:
      "Seul le bilan de l'Académie enregistré sur cet appareil est utilisé : leçons terminées, tentatives, réussites et indices d'entraînement. Aucune donnée de partie, d'adversaire ou de carte cachée n'est lue, et aucun service d'IA n'analyse ton jeu.",
    backToPractice: "Retour à l'Entraînement",
    guest: {
      title: "Connecte-toi pour ouvrir le coaching",
      body:
        "Le coaching fait partie de GRYND Pro. Connecte-toi pour vérifier ton abonnement — ta progression actuelle reste sur cet appareil.",
      cta: "Se connecter",
      free:
        "Les cinq cours, toutes les leçons, les vidéos et l'entraînement de base restent gratuits et ne demandent aucun compte.",
    },
    locked: {
      title: "Le coaching fait partie de GRYND Pro",
      body:
        "Le coaching avancé transforme ton propre bilan d'entraînement en plan. Tout ce qu'il faut pour apprendre le Solitaire reste gratuit.",
      whatTitle: "Ce qu'il fait",
      what:
        "Il construit une vue privée de ta pratique, repère les compétences que les chiffres soutiennent vraiment comme plus fragiles, et propose les exercices suivants ainsi que la leçon qui les enseigne.",
      whyTitle: "Pourquoi c'est utile",
      why:
        "Tu arrêtes de deviner quoi travailler. Le plan vise une compétence précise, le bon niveau et une séance que tu peux terminer en quelques minutes.",
      extraTitle: "Ce que tu vois en plus de l'entraînement gratuit",
      extra:
        "Taux de réussite par compétence et par difficulté, usage des indices, progression dans le temps, comparaisons d'une semaine à l'autre et plan quotidien.",
      point1: "Taux de réussite par compétence et par difficulté.",
      point2: "Usage des indices et son effet sur tes résultats.",
      point3:
        "Progression dans le temps, avec comparaisons uniquement quand l'historique suffit.",
      point4: "Un plan quotidien déterministe construit à partir de tes tentatives.",
      cta: "Découvrir GRYND Pro",
      note:
        "Rien de nécessaire pour apprendre le jeu n'est verrouillé : les cinq cours, les 20 leçons, les démonstrations, les exercices du parcours, les indices, les vérifications, les vidéos et l'entraînement de base restent gratuits.",
    },
    unavailable: {
      title: "Impossible de vérifier ton abonnement pour le moment",
      body:
        "C'est un problème de connexion temporaire, pas un changement d'abonnement. Ta progression est intacte. Réessaie dans un instant.",
    },
    totals: {
      lessons: "Leçons terminées",
      lessonsSub: "{completed} leçons sur {total}",
      exercises: "Exercices terminés",
      exercisesSub: "{completed} sur {attempted} essayés",
      success: "Réussite à l'entraînement",
      hints: "Indices utilisés",
      practiceSub: "{attempts} tentatives",
    },
    skills: {
      title: "Réussite par compétence",
      note:
        "Seules les compétences que tu as travaillées apparaissent ici. Il faut au moins {min} tentatives pour qu'une compétence soit considérée comme fragile.",
      empty:
        "Pas encore de données par compétence. Termine un exercice dans l'Entraînement et il apparaîtra ici.",
      skill: "Compétence",
      attempts: "Tentatives",
      completions: "Réussites",
      success: "Réussite",
      hints: "Indices",
    },
    difficulties: {
      title: "Réussite par difficulté",
      note: "Comment tes résultats évoluent quand les exercices deviennent plus durs.",
      empty: "Pas encore de données par difficulté.",
      level: "Difficulté",
    },
    history: {
      title: "Progression dans le temps",
      note: "Activité d'entraînement enregistrée sur cet appareil, par jour.",
      empty:
        "Pas encore assez de jours enregistrés. Ton historique se construit en pratiquant.",
      legend:
        "Les barres montrent les tentatives ; la partie plus claire montre les réussites.",
    },
    comparison: {
      title: "D'une semaine à l'autre",
      note:
        "Affiché seulement quand les deux semaines comptent au moins {min} tentatives.",
      current: "7 derniers jours",
      previous: "7 jours précédents",
      success: "Taux de réussite",
      attempts: "Tentatives",
      hints: "Indices",
      delta: "Évolution",
      notEnough:
        "Pas encore assez d'historique pour une comparaison honnête. Continue — il faut deux semaines avec quelques tentatives chacune.",
    },
    weak: {
      title: "Points à améliorer",
      note:
        "D'après tes tentatives, réussites et indices enregistrés — pas d'après un seul coup.",
      none:
        "Aucune faiblesse n'est soutenue par les données pour le moment. C'est bon signe, pas un rapport manquant.",
      lowSuccess:
        "Taux de réussite inférieur à {rate} % sur {attempts} tentatives.",
      hintReliance:
        "Tu as utilisé au moins un indice par tentative ({hints} indices pour {attempts} tentatives).",
      unfinished: "{unfinished} tentatives sur {attempts} n'ont pas été terminées.",
      practice: "Travailler cette compétence",
    },
    recommendations: {
      title: "À faire ensuite",
      note:
        "Chaque suggestion vient d'un résultat enregistré. Rien ici n'est généré par un modèle d'IA.",
      resumeLesson: "Tu as commencé cette leçon sans la terminer.",
      lowSuccess:
        "Cette compétence est l'écart le plus net de ton bilan d'entraînement.",
      hintReliance:
        "Les indices portent cette compétence ; un court exercice peut la rendre autonome.",
      unfinished:
        "Cette compétence a des tentatives inachevées qui méritent d'être rejouées.",
      readyForNextLevel:
        "Tes résultats ici sont assez solides pour un exercice plus difficile.",
      openPractice: "Ouvrir l'exercice",
      openLesson: "Ouvrir la leçon",
      empty:
        "Pas encore de recommandation. Le coaching ne propose quelque chose que si ton bilan le justifie.",
    },
    plan: {
      title: "Ton plan quotidien",
      note:
        "Une courte séance déterministe construite à partir du même bilan. Aucun contenu nouveau, aucun tirage au hasard.",
      focus: "Compétence ciblée",
      difficulty: "Difficulté",
      lesson: "Leçon à revoir",
      daily: "Séance quotidienne",
      minutes: "{count} min",
      unavailable: "Pas encore de plan",
      noPracticeData:
        "Termine quelques exercices d'entraînement et un plan apparaîtra ici.",
      notEnoughData:
        "Il n'y a pas encore assez de pratique enregistrée pour construire un plan.",
      focusWeakSkill:
        "Construit autour de la compétence que ton bilan montre comme la plus à travailler.",
      resumeLesson: "Construit autour de la leçon que tu as déjà commencée.",
      itemPractice: "Exercice : {title}",
      itemLesson: "Leçon : {title}",
      start: "Commencer par cette compétence",
    },
    practiceEntry: {
      title: "Coaching GRYND Pro",
      body:
        "Transforme ton bilan d'entraînement en analyses, exercices ciblés et court plan quotidien.",
      cta: "Ouvrir le coaching",
      badge: "Pro",
    },
  },

  es: {
    kicker: "GRYND Pro · Coaching de la Academia",
    title: "Coaching avanzado",
    description:
      "El coaching lee el registro de práctica y lecciones guardado en este dispositivo y lo convierte en analíticas, recomendaciones concretas y un plan diario corto. Nunca inventa un punto débil y nunca envía tus datos de aprendizaje a otro sitio.",
    proBadge: "Pro",
    loading: "Leyendo tu registro de aprendizaje…",
    errorTitle: "No se pudo cargar tu informe de coaching",
    errorBody:
      "Tu progreso de aprendizaje está a salvo en este dispositivo. No se ha perdido nada: inténtalo de nuevo en un momento.",
    retry: "Reintentar",
    updated: "Actualizado a las {time}",
    privacy:
      "Solo se usa el registro de la Academia guardado en este dispositivo: lecciones completadas, intentos, aciertos y pistas de práctica. No se leen datos de partidas, rivales ni cartas ocultas, y ningún servicio de IA analiza tu juego.",
    backToPractice: "Volver a Práctica",
    guest: {
      title: "Inicia sesión para abrir el coaching",
      body:
        "El coaching forma parte de GRYND Pro. Inicia sesión para comprobar tu suscripción: tu progreso actual sigue en este dispositivo.",
      cta: "Iniciar sesión",
      free:
        "Los cinco cursos, todas las lecciones, los vídeos y la práctica básica siguen siendo gratis y no requieren cuenta.",
    },
    locked: {
      title: "El coaching forma parte de GRYND Pro",
      body:
        "El coaching avanzado convierte tu propio registro de práctica en un plan. Todo lo que necesitas para aprender Solitario sigue siendo gratis.",
      whatTitle: "Qué hace",
      what:
        "Crea una vista privada de tu práctica, detecta las habilidades que los números respaldan como más flojas y sugiere los siguientes ejercicios y la lección que las enseña.",
      whyTitle: "Por qué ayuda",
      why:
        "Dejas de adivinar qué practicar. El plan señala una habilidad concreta, la dificultad adecuada y una sesión que puedes terminar en unos minutos.",
      extraTitle: "Qué ves además de la práctica gratuita",
      extra:
        "Tasa de acierto por habilidad y por dificultad, uso de pistas, progreso en el tiempo, comparaciones semanales y un plan diario.",
      point1: "Tasa de acierto por habilidad y por dificultad.",
      point2: "Uso de pistas y cómo cambia tus resultados.",
      point3:
        "Progreso en el tiempo, con comparaciones solo cuando hay historial suficiente.",
      point4: "Un plan diario determinista creado a partir de tus intentos.",
      cta: "Ver GRYND Pro",
      note:
        "Nada de lo necesario para aprender el juego está bloqueado: los cinco cursos, las 20 lecciones, las demostraciones, los ejercicios del curso, las pistas, las comprobaciones, los vídeos y la práctica básica siguen siendo gratis.",
    },
    unavailable: {
      title: "No podemos comprobar tu suscripción ahora mismo",
      body:
        "Es un problema temporal de conexión, no un cambio en tu suscripción. Tu progreso no se ha tocado. Inténtalo de nuevo en un momento.",
    },
    totals: {
      lessons: "Lecciones completadas",
      lessonsSub: "{completed} de {total} lecciones",
      exercises: "Ejercicios completados",
      exercisesSub: "{completed} de {attempted} intentados",
      success: "Acierto en práctica",
      hints: "Pistas usadas",
      practiceSub: "{attempts} intentos",
    },
    skills: {
      title: "Acierto por habilidad",
      note:
        "Solo aparecen las habilidades que has practicado. Hacen falta al menos {min} intentos para que el coaching la considere un punto débil.",
      empty:
        "Aún no hay datos por habilidad. Termina un ejercicio en Práctica y aparecerá aquí.",
      skill: "Habilidad",
      attempts: "Intentos",
      completions: "Completados",
      success: "Acierto",
      hints: "Pistas",
    },
    difficulties: {
      title: "Acierto por dificultad",
      note: "Cómo cambian tus resultados cuando los ejercicios se vuelven más difíciles.",
      empty: "Aún no hay datos por dificultad.",
      level: "Dificultad",
    },
    history: {
      title: "Progreso en el tiempo",
      note: "Actividad de práctica registrada en este dispositivo, por día.",
      empty:
        "Aún no hay suficientes días registrados. Tu historial se construye practicando.",
      legend:
        "Las barras muestran intentos; la parte más clara muestra los completados.",
    },
    comparison: {
      title: "Semana a semana",
      note:
        "Solo se muestra cuando ambas semanas tienen al menos {min} intentos.",
      current: "Últimos 7 días",
      previous: "7 días anteriores",
      success: "Tasa de acierto",
      attempts: "Intentos",
      hints: "Pistas",
      delta: "Cambio",
      notEnough:
        "Aún no hay historial suficiente para una comparación justa. Sigue practicando: hacen falta dos semanas con varios intentos en cada una.",
    },
    weak: {
      title: "Áreas a mejorar",
      note:
        "Basado en tus intentos, aciertos y pistas registrados, no en una sola jugada.",
      none:
        "Ningún punto débil está respaldado por los datos ahora mismo. Es buena señal, no un informe que falte.",
      lowSuccess:
        "La tasa de acierto está por debajo del {rate}% en {attempts} intentos.",
      hintReliance:
        "Usaste al menos una pista por intento ({hints} pistas para {attempts} intentos).",
      unfinished: "{unfinished} de {attempts} intentos no se completaron.",
      practice: "Practicar esta habilidad",
    },
    recommendations: {
      title: "Siguiente paso recomendado",
      note:
        "Cada sugerencia viene de un resultado registrado. Nada de esto lo genera un modelo de IA.",
      resumeLesson: "Empezaste esta lección pero no la terminaste.",
      lowSuccess:
        "Esta habilidad es el hueco más claro de tu registro de práctica.",
      hintReliance:
        "Las pistas sostienen esta habilidad; un ejercicio corto puede hacerla independiente.",
      unfinished:
        "Esta habilidad tiene intentos sin terminar que conviene repetir.",
      readyForNextLevel:
        "Tus resultados aquí son lo bastante sólidos para un ejercicio más difícil.",
      openPractice: "Abrir ejercicio",
      openLesson: "Abrir lección",
      empty:
        "Aún no hay recomendación. El coaching solo sugiere algo cuando tu registro lo respalda.",
    },
    plan: {
      title: "Tu plan diario",
      note:
        "Una sesión corta y determinista creada con el mismo registro. Sin contenido nuevo y sin elecciones al azar.",
      focus: "Habilidad principal",
      difficulty: "Dificultad",
      lesson: "Lección para repasar",
      daily: "Sesión diaria",
      minutes: "{count} min",
      unavailable: "Aún no hay plan",
      noPracticeData:
        "Termina unos ejercicios de práctica y aparecerá un plan aquí.",
      notEnoughData:
        "Aún no hay suficiente práctica registrada para crear un plan.",
      focusWeakSkill:
        "Creado alrededor de la habilidad que tu registro muestra como más pendiente.",
      resumeLesson: "Creado alrededor de la lección que ya empezaste.",
      itemPractice: "Ejercicio: {title}",
      itemLesson: "Lección: {title}",
      start: "Empezar por esta habilidad",
    },
    practiceEntry: {
      title: "Coaching GRYND Pro",
      body:
        "Convierte tu registro de práctica en analíticas, ejercicios concretos y un plan diario corto.",
      cta: "Abrir coaching",
      badge: "Pro",
    },
  },
};
