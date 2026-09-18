/**
 * Calendar-based age verification.
 *
 * The previous implementation divided elapsed milliseconds by 365.25 days.
 * That approximation drifts by a day or two around birthdays and mishandles
 * 29 February, so a player could be treated as 18 slightly early. Counting
 * whole calendar years is exact.
 *
 * Birth dates arrive as `yyyy-mm-dd` strings, which `new Date()` parses as
 * UTC midnight, so both sides of the comparison use UTC accessors. That makes
 * the result identical on the server and in the browser regardless of the
 * local time zone — the server (see /api/update-birthdate) remains the
 * authoritative calculation.
 */

/** Minimum age required to play. */
export const MINIMUM_AGE = 18;

/** Upper sanity bound — a birth date implying more than this is rejected. */
export const MAXIMUM_AGE = 120;

/**
 * Whole calendar years between `birthDate` and `now`.
 *
 * Returns `null` when the birth date is missing or unparseable, so callers
 * fail closed instead of doing arithmetic on `NaN`.
 */
export function calculateAge(
  birthDate: string | Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!birthDate) return null;

  const birth = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;

  let age = now.getUTCFullYear() - birth.getUTCFullYear();

  const monthDelta = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }

  return age;
}
