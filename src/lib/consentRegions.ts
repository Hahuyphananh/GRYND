// src/lib/consentRegions.ts
//
// Which visitors Google's certified CMP has to prompt.
//
// Google requires a certified CMP integrated with the IAB TCF when serving
// ads to users in three regions — the EEA and the UK since 16 January 2024,
// and Switzerland since 31 July 2024:
//
//   https://support.google.com/adsense/answer/13554116
//
// Those visitors get Google's own consent message (which also writes the TCF
// consent string our ad partners read). Everyone else keeps our own banner.
// Showing BOTH to the same visitor would be two prompts over two disagreeing
// consent records, so the regions drive which one is allowed to render.

/**
 * ISO 3166-1 alpha-2 codes for the EEA, the UK and Switzerland.
 *
 * The EEA is the 27 EU member states plus Iceland, Liechtenstein and Norway.
 * A few non-ISO aliases are included defensively because edge providers and
 * privacy proxies disagree on them in practice: `UK` (instead of `GB`),
 * `EL`/`EI` (Greece and Ireland, used by some EU systems). A false positive
 * only means a visitor sees Google's CMP instead of ours, which is safe;
 * a false negative would mean no compliant prompt at all, which is not.
 */
export const EEA_UK_CH_COUNTRIES: ReadonlySet<string> = new Set([
  // EU 27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
  // EEA non-EU
  "IS", "LI", "NO",
  // UK
  "GB", "UK",
  // Switzerland
  "CH",
  // Aliases seen from some edge/proxy providers
  "EL", "EI",
]);

/**
 * Header names that carry the visitor's country, in the order we trust them.
 *
 * `x-vercel-ip-country` is set by the Vercel edge for every request
 * (https://vercel.com/docs/headers/request-headers). `cf-ipcountry` covers a
 * Cloudflare-fronted deployment. Neither is present in local `next dev`, where
 * the result is an empty string and the visitor is treated as non-EU — so the
 * local experience is our own banner, which is what we want to be testing.
 */
const COUNTRY_HEADERS = ["x-vercel-ip-country", "cf-ipcountry", "x-country-code"];

/**
 * Resolve the visitor's country from the request headers, uppercased, or `""`
 * when nothing reports one.
 */
export function countryFromHeaders(headers: Headers): string {
  for (const name of COUNTRY_HEADERS) {
    const value = headers.get(name);
    if (value && value.trim()) return value.trim().toUpperCase();
  }
  return "";
}

/**
 * True when the visitor is in the EEA, the UK or Switzerland — i.e. when
 * Google's CMP is the one that must collect consent, and our own banner must
 * stay out of the way.
 */
export function requiresGoogleCmp(country: string): boolean {
  return EEA_UK_CH_COUNTRIES.has(country.toUpperCase());
}
