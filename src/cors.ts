/** Environment variable holding the origins allowed to read this API. */
export const CORS_ORIGINS_ENV = 'CORS_ORIGINS';

/** The value that opts every origin in, rather than naming them. */
export const ANY_ORIGIN = '*';

const FORMAT =
  'expected a comma-separated list of origins, e.g. ' +
  'https://www.home-assistant.io,https://esphome.io — or "*" for any origin';

/**
 * Parse the allowed origins out of the CORS_ORIGINS environment variable.
 *
 * Returns the normalised origins, `["*"]` when any origin is allowed, or an
 * empty list when the variable is unset or blank. An empty list means no
 * cross-origin access: browsers on other sites cannot read the API, which is the
 * safe default for a deployment that has not said who may.
 *
 * Malformed entries throw, so a typo fails startup rather than silently dropping
 * a site that was meant to be allowed — a failure that would otherwise surface
 * only in someone else's browser console.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  // A trailing or doubled comma is a typo, not an origin.
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return [];
  }

  if (entries.includes(ANY_ORIGIN)) {
    // Allowing any origin makes the specific ones meaningless, so listing both
    // means one of the two was not what the operator intended.
    if (entries.length > 1) {
      throw new Error(
        `${CORS_ORIGINS_ENV} mixes "${ANY_ORIGIN}" with specific origins — list one or the other`,
      );
    }
    return [ANY_ORIGIN];
  }

  const origins = entries.map(toOrigin);
  const seen = new Set<string>();
  for (const origin of origins) {
    // Hosts and schemes are case-insensitive, so two entries can normalise to
    // the same origin without looking alike in the config.
    if (seen.has(origin)) {
      throw new Error(`${CORS_ORIGINS_ENV} lists "${origin}" twice`);
    }
    seen.add(origin);
  }
  return origins;
}

/**
 * Normalise one entry to the origin a browser would send: scheme, host and any
 * non-default port, lowercased, with nothing else.
 */
function toOrigin(entry: string, index: number): string {
  const at = `${CORS_ORIGINS_ENV}[${index}] "${entry}"`;

  // Checked before parsing: "https://*.example.com" is a valid URL, so the
  // parser would accept a pattern that CORS matching never expands.
  if (entry.includes(ANY_ORIGIN)) {
    throw new Error(
      `${at} cannot contain a wildcard — name each origin, or use "${ANY_ORIGIN}" alone for any`,
    );
  }

  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new Error(`${at} is not a URL — ${FORMAT}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${at} must use http or https — ${FORMAT}`);
  }
  if (url.username || url.password) {
    throw new Error(`${at} must not carry credentials`);
  }
  // An Origin header is scheme, host and port only. A path here would never
  // match, so it is a misunderstanding worth naming rather than trimming.
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      `${at} must be a scheme and host only — an Origin header carries no path, query or fragment`,
    );
  }

  return url.origin;
}
