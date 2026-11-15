// standalone/solitaire-duel/src/match.ts
//
// The standalone build keeps its imports (`./match`) but the controller itself
// now lives in `src/lib/solitaire-duel/localMatch.ts`, shared with the web app's
// offline "Play vs Bots" arena. One engine, two shells: a local race cannot
// drift between the portal build and GRYND.

export * from "../../../src/lib/solitaire-duel/localMatch";
