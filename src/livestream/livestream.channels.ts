export interface Channel {
  /** URL-safe identifier used in the API path, e.g. "home-assistant". */
  slug: string;
  /** YouTube handle without the leading "@". */
  handle: string;
}

/** DI token for the parsed, validated channel list. */
export const LIVESTREAM_CHANNELS = Symbol('LIVESTREAM_CHANNELS');

/** Slugs appear in the API path, so keep them unambiguous. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What a YouTube handle may contain: letters, digits, dots, underscores and
 * hyphens, and at least one alphanumeric so punctuation alone ("--", "...") is
 * rejected. Enforced so a malformed handle fails the deploy rather than every
 * channels.list request at runtime.
 */
const HANDLE_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._-]+$/;

const ENV_VAR = 'LIVESTREAM_CHANNELS';
const FORMAT = 'expected a comma-separated list of handle:slug pairs';

/**
 * Canonical YouTube channel RSS feed URL — the discovery source for livestream
 * state. Fetching it costs no YouTube Data API quota, unlike the videos.list
 * lookup that classifies the videos it returns.
 */
export const feedUrl = (channelId: string): string =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

/**
 * Parse the tracked channels out of the LIVESTREAM_CHANNELS environment
 * variable, e.g. `home_assistant:home-assistant,esphomeio:esphome`. Adding or
 * removing a project is a config change, not a code change.
 *
 * Each entry pairs the YouTube handle used to find the channel with the slug
 * this API serves it under. The slug is pinned here rather than derived from
 * the channel's YouTube name so that renaming the channel cannot silently
 * change our public URLs. Display names are read from the channel feed at
 * runtime, so they are deliberately not configured.
 *
 * Throws on missing or malformed config rather than quietly tracking nothing,
 * so a bad deploy fails loudly instead of serving an empty channel list.
 */
export function parseChannels(raw: string | undefined): Channel[] {
  if (raw === undefined || raw === null) {
    throw new Error(`${ENV_VAR} is not set: ${FORMAT}`);
  }

  // A trailing or doubled comma is a typo, not a channel.
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Reported distinctly from unset, so an operator who did set the variable is
  // not sent looking for a missing one. Blank and comma-only values are the
  // same mistake, so they share this message.
  if (entries.length === 0) {
    throw new Error(`${ENV_VAR} is set but lists no channels: ${FORMAT}`);
  }

  const channels = entries.map(toChannel);
  const slugs = new Set<string>();
  const handles = new Set<string>();
  for (const { slug, handle } of channels) {
    if (slugs.has(slug)) {
      throw new Error(`${ENV_VAR} has a duplicate slug "${slug}"`);
    }
    slugs.add(slug);
    // YouTube handles are case-insensitive, so two entries differing only in
    // case would poll one channel twice and serve it under two slugs.
    const handleKey = handle.toLowerCase();
    if (handles.has(handleKey)) {
      throw new Error(
        `${ENV_VAR} has two channels pointing at the same handle "${handle}"`,
      );
    }
    handles.add(handleKey);
  }
  return channels;
}

function toChannel(entry: string, index: number): Channel {
  const at = `${ENV_VAR}[${index}] "${entry}"`;

  // A pasted channel URL carries its own colon, so name the real mistake rather
  // than blaming the colon count.
  if (entry.includes('://')) {
    throw new Error(
      `${at} looks like a URL — use the bare handle and slug, e.g. esphomeio:esphome`,
    );
  }

  const parts = entry.split(':');
  if (parts.length !== 2) {
    throw new Error(
      `${at} must be one handle and one slug separated by ":" — ${FORMAT}`,
    );
  }

  const declaredHandle = parts[0].trim();
  if (!declaredHandle) {
    throw new Error(`${at} has no handle before the ":"`);
  }
  // Accept a leading "@" for convenience; channels.list wants it bare. Checked
  // after the emptiness test so "@" alone gets its own message.
  const handle = declaredHandle.replace(/^@+/, '');
  if (!handle) {
    throw new Error(`${at} handle must name a channel, not just "@"`);
  }
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error(
      `${at} handle "${handle}" must be a bare handle — letters, digits, dots, underscores and hyphens only, not a URL`,
    );
  }

  const slug = parts[1].trim();
  if (!slug) {
    throw new Error(`${at} has no slug after the ":"`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `${at} slug "${slug}" must be lowercase letters, digits and single hyphens — it appears in the API path`,
    );
  }

  return { slug, handle };
}
