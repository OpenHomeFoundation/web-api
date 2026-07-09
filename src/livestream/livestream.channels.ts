export interface Channel {
  /** URL-safe identifier used in the API path, e.g. "home-assistant". */
  slug: string;
  /** Human-friendly display name. */
  name: string;
  /** YouTube handle without the leading "@". */
  handle: string;
}

/**
 * Open Home Foundation project channels tracked for livestreams.
 * Add a new project by appending an entry here — no other code changes needed.
 */
export const CHANNELS: readonly Channel[] = [
  { slug: 'home-assistant', name: 'Home Assistant', handle: 'home_assistant' },
  { slug: 'esphome', name: 'ESPHome', handle: 'esphomeio' },
  {
    slug: 'open-home-foundation',
    name: 'Open Home Foundation',
    handle: 'OpenHomeFndn',
  },
  {
    slug: 'music-assistant',
    name: 'Music Assistant',
    handle: 'musicassistantio',
  },
];

/**
 * Canonical YouTube channel RSS feed URL, used both as the discovery source and
 * as the WebSub (PubSubHubbub) subscription topic — keep a single form so the
 * two code paths cannot drift. This is the URL documented for the hub topic:
 * https://developers.google.com/youtube/v3/guides/push_notifications
 */
export const feedUrl = (channelId: string): string =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
