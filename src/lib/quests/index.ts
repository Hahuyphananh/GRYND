// src/lib/quests/index.ts
//
// The quest domain, in one import.
//
// Pure domain only: types, period keys, the canonical game catalog, the quest
// definitions/planner and the progress rules. `./store` is intentionally NOT
// re-exported — a surface that only needs to describe or advance a quest should
// not pull the database client into its module graph. Import it explicitly:
//
//   import { getQuestBoard } from "@/lib/quests/store";

export * from "./types";
export * from "./periods";
export * from "./games";
export * from "./definitions";
export * from "./progress";
