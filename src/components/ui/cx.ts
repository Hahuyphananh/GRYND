/**
 * Class name joiner. Six lines instead of a `clsx` + `tailwind-merge`
 * dependency: the primitives compose fixed variant maps, never conflicting
 * utilities from two callers, so there is nothing to merge.
 */
export type ClassValue = string | false | null | undefined;

export function cx(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(" ");
}
