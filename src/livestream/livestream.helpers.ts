/** One entry from a channel's RSS feed. */
export interface FeedEntry {
  videoId: string;
  /** Atom <updated>; YouTube bumps it when a video's metadata changes. */
  updated: string;
}

/** A channel's RSS feed: its display name plus its recent entries. */
export interface Feed {
  /** Channel-level <title>, i.e. the channel's display name. */
  title: string;
  entries: FeedEntry[];
}

const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
const videoIdPattern = /<yt:videoId>([^<]+)<\/yt:videoId>/;
const updatedPattern = /<updated>([^<]+)<\/updated>/;
const titlePattern = /<title>([^<]*)<\/title>/;

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode the XML entities an Atom element may contain, so a channel named
 * "Nabu Casa's" is not served as "Nabu Casa&#39;s". Resolved in a single pass so
 * an escaped entity ("&amp;amp;") decodes to "&amp;" rather than "&".
 */
const decodeXmlText = (value: string): string =>
  value.replace(
    /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, ref: string) => {
      if (!ref.startsWith('#')) {
        return XML_ENTITIES[ref.toLowerCase()] ?? match;
      }
      const code =
        ref[1] === 'x' || ref[1] === 'X'
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    },
  );

/** Parse a channel's Atom feed XML: its title and recent entries. */
export const parseAtomFeed = (xml: string): Feed => {
  const entries: FeedEntry[] = [];
  for (const [, entry] of xml.matchAll(entryPattern)) {
    const videoId = videoIdPattern.exec(entry)?.[1];
    if (videoId) {
      entries.push({
        videoId,
        updated: updatedPattern.exec(entry)?.[1] ?? '',
      });
    }
  }

  // The channel's own <title> precedes the entries; an entry's <title> is the
  // video's, so only look before the first one.
  const [head] = xml.split('<entry>');
  const title = titlePattern.exec(head)?.[1] ?? '';
  return { title: decodeXmlText(title).trim(), entries };
};

export const stackOf = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);
