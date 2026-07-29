/** Environment variable holding the origins allowed to read this API. */
export const CORS_ORIGINS_ENV = 'CORS_ORIGINS';

/** The value that opts every origin in, rather than naming them. */
export const ANY_ORIGIN = '*';

/** Leading label that stands for "any subdomain of what follows". */
const WILDCARD_LABEL = '*.';

const FORMAT =
  'expected a comma-separated list of origins, e.g. ' +
  'https://www.home-assistant.io,https://*.esphome.io — or "*" for any origin';

/** One label of a host name, as a wildcard entry's subdomains are matched. */
const LABEL = '[a-z0-9-]+';

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
 * non-default port, lowercased, with nothing else. A `*.` leading label is kept
 * as written; corsOriginMatchers turns it into a pattern.
 */
function toOrigin(entry: string, index: number): string {
  const at = `${CORS_ORIGINS_ENV}[${index}] "${entry}"`;

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
  if (url.hostname.includes(ANY_ORIGIN)) {
    checkWildcardHost(url.hostname, at);
  }

  return url.origin;
}

/**
 * A wildcard may only stand in for the leading label, because that is the one
 * thing subdomain matching can express: `https://*.esphome.io` covers
 * `www.esphome.io` and `a.b.esphome.io`, but nothing else about the host varies.
 */
function checkWildcardHost(hostname: string, at: string): void {
  if (
    !hostname.startsWith(WILDCARD_LABEL) ||
    hostname.slice(WILDCARD_LABEL.length).includes(ANY_ORIGIN)
  ) {
    throw new Error(
      `${at} may only use "${ANY_ORIGIN}" as its leading label, e.g. https://${WILDCARD_LABEL}esphome.io`,
    );
  }

  const labels = hostname.slice(WILDCARD_LABEL.length).split('.');
  // "*.io" would hand every .io site access, which is never what was meant.
  if (labels.length < 2) {
    throw new Error(
      `${at} must name a domain below the wildcard, e.g. https://${WILDCARD_LABEL}esphome.io`,
    );
  }
  if (!labels.every((label) => new RegExp(`^${LABEL}$`).test(label))) {
    throw new Error(`${at} has a host that is not a domain name`);
  }
}

/**
 * Turn parsed entries into what `enableCors` matches an incoming Origin against:
 * an exact origin stays a string, and a `*.` entry becomes an anchored pattern
 * over its subdomains.
 *
 * Anchored at both ends, and requiring a literal dot before the domain, so
 * `https://*.esphome.io` covers `www.esphome.io` and `a.b.esphome.io` but not
 * the bare `esphome.io` (list it too if you want it), not `evil-esphome.io`, and
 * not `esphome.io.evil.example`.
 */
export function corsOriginMatchers(origins: string[]): (string | RegExp)[] {
  const marker = `//${WILDCARD_LABEL}`;
  return origins.map((origin) => {
    const at = origin.indexOf(marker);
    if (at === -1) {
      return origin;
    }
    const scheme = origin.slice(0, at);
    const host = origin.slice(at + marker.length);
    return new RegExp(
      `^${escapeRegExp(scheme)}//(?:${LABEL}\\.)+${escapeRegExp(host)}$`,
      // Browsers send a lowercased host, but a non-browser client need not.
      'i',
    );
  });
}

/**
 * Decide whether an Origin may read this API, against the matchers `enableCors`
 * is given.
 *
 * Express answers this question itself for HTTP requests; the WebSocket
 * handshake has to ask it, because socket.io's own CORS handling only covers the
 * polling transport — a WebSocket upgrade carries an Origin but is not subject
 * to CORS at all, so the server is the only thing that can refuse it. Sharing
 * the matchers means the two cannot drift apart in what they allow.
 */
export function originMatches(
  matchers: readonly (string | RegExp)[],
  origin: string,
): boolean {
  return matchers.some((matcher) =>
    typeof matcher === 'string' ? matcher === origin : matcher.test(origin),
  );
}
