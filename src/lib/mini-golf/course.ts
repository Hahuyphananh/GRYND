// src/lib/mini-golf/course.ts
//
// Compatibility barrel for Mini Golf course generation.
//
// The implementation lives in three focused modules:
//   • courseTemplates.ts   — the controlled hole-template library
//   • courseValidation.ts  — deterministic geometric + reachability validation
//   • courseGenerator.ts   — seeded generation, difficulty ramp, re-rolls
//
// This module keeps the historical import surface (`generateCourse` etc.) so
// existing callers such as `rules.ts` do not have to care where the code moved.

export {
  buildHole,
  generateHole,
  generateHoleDetailed,
  generateCourse,
  generateCourseReport,
} from "./courseGenerator";
export type { CourseReport, HoleBuildReport } from "./courseGenerator";

export {
  validateHole,
  isHoleReachable,
  isBallPositionFree,
  analyzeReachability,
} from "./courseValidation";
export type { ReachabilityAnalysis } from "./courseValidation";

export {
  TEMPLATES,
  TEMPLATE_LEVELS,
  templateByName,
  parForLevel,
  canonicalLayout,
  mirrorLayoutX,
} from "./courseTemplates";
export type { MiniGolfTemplate, TemplateContext, TemplateLayout } from "./courseTemplates";
