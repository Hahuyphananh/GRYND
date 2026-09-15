// src/lib/onboardingFlow.js
//
// The three onboarding states, and what each combination means:
//
//   onboarding_completed_at    — the existing 5-step /welcome tutorial
//   first_game_completed_at    — the existing onboarding RPS Free Play match
//   questionnaire_completed_at — the personalization questionnaire
//   questionnaire_dismissed_at — the invitation was declined ("Maybe Later")
//
//   Sign up → questionnaire → /welcome tutorial → "first match is free"
//          → RPS Free Play vs AI onboarding match
//
// This module holds the *decisions* that keep those states from being
// conflated, so the questionnaire page, /welcome and the lobby card can't
// drift apart (and can be unit tested without rendering a page):
//
//   * questionnaireDestination      — where the questionnaire sends you
//   * shouldRouteWelcomeToQuestionnaire — does /welcome hand off to it first?
//   * shouldShowQuestionnaireInvite — does the existing-user invitation show?
//   * isQuestionnaireAnswered       — completed OR dismissed (never ask again)
//
// Every helper takes plain server state (booleans / null timestamps already
// normalized to booleans by /api/onboarding/status) and returns a decision.
// Nothing here reads storage or the network, so there is exactly one place
// where the loop-safety rules live.

/** The questionnaire is "done" (answered) or "declined" (dismissed) — in
 *  both cases we must never push it at the player again. */
export function isQuestionnaireSettled({ questionnaireCompleted, questionnaireDismissed }) {
  return questionnaireCompleted === true || questionnaireDismissed === true;
}

/**
 * Where the questionnaire navigates once the player submits or skips it.
 *
 *   ?from=settings → back to Settings (that's where they opened it)
 *   tutorial already done → the lobby (never re-enter onboarding)
 *   brand-new account → the existing /welcome tutorial, carrying
 *     `from=questionnaire` so /welcome knows not to bounce them back here
 *     (loop guard: a failed dismissal POST can never ping-pong the user).
 */
export function questionnaireDestination({ from, onboardingCompleted }) {
  if (from === "settings") return "/settings";
  if (onboardingCompleted === true) return "/casino";
  return "/welcome?from=questionnaire";
}

/**
 * Should /welcome redirect this visitor to the questionnaire first?
 *
 * True only for a genuinely unanswered brand-new account:
 *   * `replay` (Settings → Replay tutorial) always shows the tutorial;
 *   * `fromQuestionnaire` means they just came from it — never bounce back;
 *   * an account that finished the tutorial is never re-onboarded;
 *   * answered OR dismissed accounts are settled — don't nag.
 */
export function shouldRouteWelcomeToQuestionnaire({
  onboardingCompleted,
  questionnaireCompleted,
  questionnaireDismissed,
  replay,
  fromQuestionnaire,
}) {
  if (replay === true) return false;
  if (fromQuestionnaire === true) return false;
  if (onboardingCompleted === true) return false;
  return !isQuestionnaireSettled({ questionnaireCompleted, questionnaireDismissed });
}

/**
 * Should the lobby show the existing-user questionnaire invitation card?
 *
 * Only for an EXISTING player (tutorial already complete — so they are never
 * sent back through it) who has neither answered nor dismissed the
 * questionnaire, and only when this tab hasn't already dealt with it (the
 * same sessionStorage pattern the lobby's other one-time card uses).
 */
export function shouldShowQuestionnaireInvite({
  isSignedIn,
  onboardingCompleted,
  questionnaireCompleted,
  questionnaireDismissed,
  handledThisSession,
}) {
  if (isSignedIn !== true) return false;
  if (handledThisSession === true) return false;
  if (onboardingCompleted !== true) return false;
  return !isQuestionnaireSettled({ questionnaireCompleted, questionnaireDismissed });
}

/** Session key for suppressing the invitation for the rest of the session —
 *  mirrors the lobby's existing `grynd:lobby:first-battle:dismissed` key. */
export const QUESTIONNAIRE_INVITE_SESSION_KEY = "grynd:lobby:questionnaire-invite:handled";
