import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { feedUrl, YouTubeClient } from '../youtube';
import { Channel } from './livestream.channels';
import { LivestreamService } from './livestream.service';

const TICK_MS = 10_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** The service's discovery (feed re-scan) interval. */
const DISCOVERY_MS = 5 * MINUTE_MS;

/**
 * The channel list is configuration now, injected into the service, so these
 * tests own their own fixture instead of depending on whatever is deployed.
 * Display names are deliberately absent: they come from the feed, not config.
 */
const CHANNELS: Channel[] = [
  { slug: 'home-assistant', handle: 'HomeAssistant' },
  { slug: 'esphome', handle: 'ESPHome' },
  { slug: 'music-assistant', handle: 'MusicAssistant' },
  { slug: 'open-home-foundation', handle: 'OpenHomeFoundation' },
];

/**
 * The channel-level <title> each fake feed serves — the only source of the
 * display names the service reports.
 */
const FEED_TITLES: Record<string, string> = {
  'home-assistant': 'Home Assistant',
  esphome: 'ESPHome',
  'music-assistant': 'Music Assistant',
  'open-home-foundation': 'Open Home Foundation',
};

const CHANNEL_ID_PREFIX = 'UC-';
const channelIdOf = (slug: string): string => `${CHANNEL_ID_PREFIX}${slug}`;

const slugByHandle = new Map(CHANNELS.map((c) => [c.handle, c.slug]));
const slugByChannelId = new Map(
  CHANNELS.map((c) => [channelIdOf(c.slug), c.slug]),
);

interface LiveStreamingDetails {
  scheduledStartTime?: string;
  actualStartTime?: string;
  actualEndTime?: string;
}

interface FakeVideo {
  id: string;
  slug: string;
  title: string;
  liveStreamingDetails?: LiveStreamingDetails;
}

/** One feed entry. The service fingerprints the feed as `videoId@updated`. */
interface FakeFeedEntry {
  id: string;
  updated: string;
}

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A channel feed. The channel's own <title> precedes the entries, mirroring
 * YouTube; each entry then carries the *video's* title under the same tag.
 */
const atomFeed = (title: string, entries: FakeFeedEntry[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">',
    `<id>yt:channel:fake</id><title>${title}</title>`,
    ...entries.map(
      ({ id, updated }) =>
        `<entry><yt:videoId>${id}</yt:videoId><title>entry ${id}</title>` +
        `<updated>${updated}</updated></entry>`,
    ),
    '</feed>',
  ].join('');

/**
 * Mutable stand-in for the two YouTube surfaces the service talks to: the
 * Data API (channels.list / videos.list) and the free per-channel RSS feed.
 * Tests mutate it between time advances to simulate a stream going live/ending.
 */
class FakeYouTube {
  /** Entries each channel's RSS feed advertises, newest-first order. */
  private readonly feeds = new Map<string, FakeFeedEntry[]>();
  private readonly videos = new Map<string, FakeVideo>();
  private readonly brokenFeeds = new Set<string>();
  /** Channel-level feed <title> overrides, e.g. after a rebrand. */
  private readonly feedTitles = new Map<string, string>();
  /** Bodies to serve with a 200 instead of the channel's Atom feed. */
  private readonly notFeedBodies = new Map<string, string>();
  private videosListBroken = false;
  /** Bumped per generated <updated> value so each one is distinct. */
  private revision = 0;

  addStream(
    slug: string,
    id: string,
    opts: { title?: string } & LiveStreamingDetails,
  ): void {
    const { title, ...details } = opts;
    this.add(slug, id, title ?? `stream ${id}`, details);
  }

  /** A regular upload: present in the feed but with no liveStreamingDetails. */
  addUpload(slug: string, id: string, title?: string): void {
    this.add(slug, id, title ?? `upload ${id}`, undefined);
  }

  /** Announce a video in the feed more than once (YouTube occasionally does). */
  repeatInFeed(slug: string, id: string): void {
    const entry = this.feedFor(slug).find((e) => e.id === id);
    this.feedFor(slug).push({
      id,
      updated: entry?.updated ?? this.nextUpdated(),
    });
  }

  /**
   * Bump an entry's Atom <updated>, the way YouTube does when a video's
   * metadata changes — the only signal that a cached feed needs re-classifying.
   */
  bumpFeedUpdated(id: string, updated?: string): void {
    const entries = this.entriesFor(id);
    if (entries.length === 0) {
      throw new Error(`fake video "${id}" is not in any feed`);
    }
    const value = updated ?? this.nextUpdated();
    for (const entry of entries) {
      entry.updated = value;
    }
  }

  /** Retitle a video without touching the feed, as a stealth edit would. */
  setTitle(id: string, title: string): void {
    this.videoFor(id).title = title;
  }

  markLive(id: string, actualStartTime: string): void {
    this.detailsFor(id).actualStartTime = actualStartTime;
  }

  /**
   * Delete a video the way YouTube does: videos.list stops returning it (no
   * error, the ID is simply absent) and it drops out of the channel feed.
   */
  deleteVideo(id: string): void {
    const video = this.videos.get(id);
    this.videos.delete(id);
    if (video) {
      const feed = this.feedFor(video.slug);
      feed.splice(0, feed.length, ...feed.filter((entry) => entry.id !== id));
    }
  }

  markEnded(id: string, actualEndTime: string): void {
    this.detailsFor(id).actualEndTime = actualEndTime;
  }

  breakFeed(slug: string): void {
    this.brokenFeeds.add(slug);
  }

  /** Rename the channel, the way a rebrand shows up in its feed <title>. */
  setFeedTitle(slug: string, title: string): void {
    this.feedTitles.set(slug, title);
  }

  /**
   * Answer the feed request with a 200 carrying something that is not an Atom
   * feed — a captive portal, a proxy interstitial, a YouTube error page.
   */
  serveNotAFeed(slug: string, body: string): void {
    this.notFeedBodies.set(slug, body);
  }

  /** Make videos.list fail outright, as opposed to omitting an ID. */
  breakVideosList(): void {
    this.videosListBroken = true;
  }

  repairVideosList(): void {
    this.videosListBroken = false;
  }

  /**
   * Push a video out of the feed's most-recent window while videos.list still
   * serves it — what happens when a channel publishes past it.
   */
  removeFromFeed(id: string): void {
    const video = this.videoFor(id);
    const feed = this.feedFor(video.slug);
    feed.splice(0, feed.length, ...feed.filter((entry) => entry.id !== id));
  }

  readonly fetch = async (input: unknown): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/youtube/v3/channels')) {
      return this.channelsList(url);
    }
    if (url.pathname.endsWith('/youtube/v3/videos')) {
      return this.videosList(url);
    }
    if (url.pathname.endsWith('/feeds/videos.xml')) {
      return this.feed(url);
    }
    throw new Error(`unexpected fetch: ${url.toString()}`);
  };

  private channelsList(url: URL): Response {
    const slug = slugByHandle.get(url.searchParams.get('forHandle') ?? '');
    return json({ items: slug ? [{ id: channelIdOf(slug) }] : [] });
  }

  private videosList(url: URL): Response {
    if (this.videosListBroken) {
      return new Response('quota exceeded', { status: 403 });
    }
    const ids = (url.searchParams.get('id') ?? '').split(',');
    const items = ids
      .map((id) => this.videos.get(id))
      .filter((video): video is FakeVideo => Boolean(video))
      .map((video) => ({
        id: video.id,
        snippet: { title: video.title, channelId: channelIdOf(video.slug) },
        ...(video.liveStreamingDetails
          ? { liveStreamingDetails: video.liveStreamingDetails }
          : {}),
      }));
    return json({ items });
  }

  private feed(url: URL): Response {
    const slug = slugByChannelId.get(url.searchParams.get('channel_id') ?? '');
    if (!slug) {
      return new Response('not found', { status: 404 });
    }
    if (this.brokenFeeds.has(slug)) {
      return new Response('boom', { status: 500 });
    }
    const notAFeed = this.notFeedBodies.get(slug);
    if (notAFeed !== undefined) {
      return new Response(notAFeed, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(atomFeed(this.titleFor(slug), this.feedFor(slug)), {
      status: 200,
      headers: { 'content-type': 'application/atom+xml' },
    });
  }

  private titleFor(slug: string): string {
    return this.feedTitles.get(slug) ?? FEED_TITLES[slug] ?? slug;
  }

  private add(
    slug: string,
    id: string,
    title: string,
    details: LiveStreamingDetails | undefined,
  ): void {
    this.videos.set(id, {
      id,
      slug,
      title,
      liveStreamingDetails: details,
    });
    this.feedFor(slug).push({ id, updated: this.nextUpdated() });
  }

  private feedFor(slug: string): FakeFeedEntry[] {
    const entries = this.feeds.get(slug) ?? [];
    this.feeds.set(slug, entries);
    return entries;
  }

  private entriesFor(id: string): FakeFeedEntry[] {
    return [...this.feeds.values()].flat().filter((entry) => entry.id === id);
  }

  private nextUpdated(): string {
    return new Date(Date.now() + ++this.revision).toISOString();
  }

  private videoFor(id: string): FakeVideo {
    const video = this.videos.get(id);
    if (!video) {
      throw new Error(`fake video "${id}" does not exist`);
    }
    return video;
  }

  private detailsFor(id: string): LiveStreamingDetails {
    const video = this.videos.get(id);
    if (!video?.liveStreamingDetails) {
      throw new Error(`fake video "${id}" is not a livestream`);
    }
    return video.liveStreamingDetails;
  }
}

describe('LivestreamService', () => {
  let yt: FakeYouTube;
  let fetchMock: jest.Mock;
  let originalFetch: typeof globalThis.fetch;
  let services: LivestreamService[];
  /** Frozen wall clock for the test; all expected times derive from it. */
  let now: number;

  const iso = (offsetMs = 0): string => new Date(now + offsetMs).toISOString();

  const createService = (
    env: Record<string, string | undefined> = { YOUTUBE_API_KEY: 'test-key' },
  ): LivestreamService => {
    const config = { get: (key: string) => env[key] } as ConfigService;
    const service = new LivestreamService(CHANNELS, new YouTubeClient(config));
    services.push(service);
    return service;
  };

  /** onModuleInit kicks off discovery without awaiting it; let it finish. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await jest.advanceTimersByTimeAsync(0);
    }
  };

  const start = async (
    service: LivestreamService = createService(),
  ): Promise<LivestreamService> => {
    // Synchronous: it starts the timers and kicks off discovery without
    // awaiting it, so settle() is what lets that first sweep finish.
    service.onModuleInit();
    await settle();
    return service;
  };

  const callsTo = (path: string): unknown[][] =>
    fetchMock.mock.calls.filter((call) => String(call[0]).includes(path));

  const videosListCalls = () => callsTo('/youtube/v3/videos');

  const idsRequestedIn = (call: unknown[]): string[] =>
    (new URL(String(call[0])).searchParams.get('id') ?? '').split(',');

  beforeEach(() => {
    jest.useFakeTimers();
    now = Date.now();
    yt = new FakeYouTube();
    fetchMock = jest.fn(yt.fetch);
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    services = [];
    // The service logs expected failures (bad feed, missing key) — keep the
    // test output readable without swallowing real errors.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const service of services) {
      service.onModuleDestroy();
    }
    globalThis.fetch = originalFetch;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('lists every configured channel in order, defaulting to "none" before any data arrives', () => {
    const service = createService();

    const all = service.getAll();

    expect(all).toHaveLength(CHANNELS.length);
    expect(all.map((info) => info.channel)).toEqual(
      CHANNELS.map((c) => c.slug),
    );
    // No feed has been read yet, so the names are not known.
    expect(all.map((info) => info.channelName)).toEqual(
      CHANNELS.map((c) => c.slug),
    );
    for (const info of all) {
      expect(info.status).toBe('none');
      expect(info.updatedAt).toBe(iso());
      expect(info.title).toBeUndefined();
      expect(info.url).toBeUndefined();
      expect(info.startTime).toBeUndefined();
    }
  });

  it('reports a scheduled stream as "upcoming" with its title, watch URL and start time', async () => {
    yt.addStream('home-assistant', 'vid-upcoming', {
      title: 'Release Party 2026.8',
      scheduledStartTime: iso(2 * HOUR_MS),
    });

    const service = await start();

    expect(service.getStatus('home-assistant')).toEqual({
      channel: 'home-assistant',
      channelName: 'Home Assistant',
      status: 'upcoming',
      title: 'Release Party 2026.8',
      url: 'https://www.youtube.com/watch?v=vid-upcoming',
      startTime: iso(2 * HOUR_MS),
      updatedAt: iso(),
    });
  });

  it('ignores a regular upload that is not a livestream', async () => {
    yt.addUpload('esphome', 'vid-upload', 'How to flash an ESP32');

    const service = await start();

    const info = service.getStatus('esphome');
    expect(info.status).toBe('none');
    expect(info.title).toBeUndefined();
    expect(info.url).toBeUndefined();
  });

  it('does not report a stream that ended more than 24 hours ago', async () => {
    yt.addStream('esphome', 'vid-ancient', {
      scheduledStartTime: iso(-26 * HOUR_MS),
      actualStartTime: iso(-26 * HOUR_MS),
      actualEndTime: iso(-25 * HOUR_MS),
    });

    const service = await start();

    expect(service.getStatus('esphome').status).toBe('none');
  });

  it('reports a stream that ended within the last 24 hours as "past"', async () => {
    yt.addStream('music-assistant', 'vid-recent', {
      title: 'Music Assistant 3.0 launch',
      scheduledStartTime: iso(-3 * HOUR_MS),
      actualStartTime: iso(-3 * HOUR_MS),
      actualEndTime: iso(-2 * HOUR_MS),
    });

    const service = await start();

    const info = service.getStatus('music-assistant');
    expect(info.status).toBe('past');
    expect(info.title).toBe('Music Assistant 3.0 launch');
    expect(info.url).toBe('https://www.youtube.com/watch?v=vid-recent');
  });

  it('flips an imminent "upcoming" stream to "live" on the next reconcile tick', async () => {
    yt.addStream('home-assistant', 'vid-soon', {
      title: 'Live Q&A',
      scheduledStartTime: iso(5 * MINUTE_MS),
    });
    const service = await start();
    expect(service.getStatus('home-assistant').status).toBe('upcoming');

    yt.markLive('vid-soon', iso(5 * MINUTE_MS));
    await jest.advanceTimersByTimeAsync(TICK_MS);

    const info = service.getStatus('home-assistant');
    expect(info.status).toBe('live');
    expect(info.title).toBe('Live Q&A');
    expect(info.url).toBe('https://www.youtube.com/watch?v=vid-soon');
    // Retained across the transition: a client watching a stream go live must
    // not see startTime appear and then vanish.
    expect(info.startTime).toBe(iso(5 * MINUTE_MS));
  });

  it('reports no start time for a stream that went live without being scheduled', async () => {
    yt.addStream('home-assistant', 'vid-impromptu', {
      title: 'Impromptu stream',
      actualStartTime: iso(-2 * MINUTE_MS),
    });

    const service = await start();

    const info = service.getStatus('home-assistant');
    expect(info.status).toBe('live');
    expect(info.title).toBe('Impromptu stream');
    expect(info.startTime).toBeUndefined();
  });

  it('flips a "live" stream to "past" once it ends', async () => {
    yt.addStream('home-assistant', 'vid-live', {
      title: 'Ongoing stream',
      scheduledStartTime: iso(-30 * MINUTE_MS),
      actualStartTime: iso(-30 * MINUTE_MS),
    });
    const service = await start();
    expect(service.getStatus('home-assistant').status).toBe('live');

    yt.markEnded('vid-live', iso());
    await jest.advanceTimersByTimeAsync(TICK_MS);

    const info = service.getStatus('home-assistant');
    expect(info.status).toBe('past');
    expect(info.url).toBe('https://www.youtube.com/watch?v=vid-live');
  });

  it('reports the earliest upcoming stream when several are scheduled', async () => {
    yt.addStream('open-home-foundation', 'vid-later', {
      title: 'Later',
      scheduledStartTime: iso(4 * HOUR_MS),
    });
    yt.addStream('open-home-foundation', 'vid-earliest', {
      title: 'Earliest',
      scheduledStartTime: iso(1 * HOUR_MS),
    });
    yt.addStream('open-home-foundation', 'vid-middle', {
      title: 'Middle',
      scheduledStartTime: iso(2 * HOUR_MS),
    });

    const service = await start();

    const info = service.getStatus('open-home-foundation');
    expect(info.status).toBe('upcoming');
    expect(info.title).toBe('Earliest');
    expect(info.startTime).toBe(iso(1 * HOUR_MS));
  });

  it('prefers a live stream over an upcoming one on the same channel', async () => {
    yt.addStream('home-assistant', 'vid-next-week', {
      title: 'Next release party',
      scheduledStartTime: iso(3 * HOUR_MS),
    });
    yt.addStream('home-assistant', 'vid-now', {
      title: 'Streaming right now',
      scheduledStartTime: iso(-10 * MINUTE_MS),
      actualStartTime: iso(-10 * MINUTE_MS),
    });

    const service = await start();

    const info = service.getStatus('home-assistant');
    expect(info.status).toBe('live');
    expect(info.title).toBe('Streaming right now');
    expect(info.url).toBe('https://www.youtube.com/watch?v=vid-now');
  });

  it('spends no videos.list quota on ticks while the only upcoming stream is hours away', async () => {
    yt.addStream('home-assistant', 'vid-far', {
      scheduledStartTime: iso(3 * HOUR_MS),
    });
    await start();
    const afterDiscovery = videosListCalls().length;
    expect(afterDiscovery).toBe(1);

    // Every tick reconciles, but a stream this far out is not selected as
    // active, so no request goes out and no extra quota is spent.
    await jest.advanceTimersByTimeAsync(9 * TICK_MS);

    expect(videosListCalls()).toHaveLength(afterDiscovery);
  });

  it('re-queries videos.list on every 10s tick while a stream is live', async () => {
    yt.addStream('home-assistant', 'vid-live', {
      scheduledStartTime: iso(-5 * MINUTE_MS),
      actualStartTime: iso(-5 * MINUTE_MS),
    });
    await start();
    const afterDiscovery = videosListCalls().length;

    await jest.advanceTimersByTimeAsync(3 * TICK_MS);

    const calls = videosListCalls();
    expect(calls).toHaveLength(afterDiscovery + 3);
    expect(idsRequestedIn(calls[calls.length - 1])).toEqual(['vid-live']);
  });

  it('starts polling videos.list once an upcoming stream comes within 15 minutes', async () => {
    yt.addStream('home-assistant', 'vid-nearly', {
      scheduledStartTime: iso(16 * MINUTE_MS),
    });
    await start();
    const afterDiscovery = videosListCalls().length;

    // Still outside the 15-minute window: no polling.
    await jest.advanceTimersByTimeAsync(5 * TICK_MS);
    expect(videosListCalls()).toHaveLength(afterDiscovery);

    // Now inside it: every tick re-queries the stream.
    await jest.advanceTimersByTimeAsync(3 * TICK_MS);
    expect(videosListCalls()).toHaveLength(afterDiscovery + 3);
  });

  it('stops all polling after onModuleDestroy', async () => {
    yt.addStream('home-assistant', 'vid-live', {
      scheduledStartTime: iso(-5 * MINUTE_MS),
      actualStartTime: iso(-5 * MINUTE_MS),
    });
    const service = await start();
    const callsBefore = fetchMock.mock.calls.length;

    service.onModuleDestroy();
    // Well past both the 10s reconcile tick and the 5min discovery interval.
    await jest.advanceTimersByTimeAsync(20 * MINUTE_MS);

    expect(fetchMock.mock.calls).toHaveLength(callsBefore);
  });

  it('serves a deterministic "none" for a channel whose feed fails, without affecting the others', async () => {
    yt.breakFeed('esphome');
    yt.addStream('home-assistant', 'vid-ok', {
      title: 'Unaffected',
      scheduledStartTime: iso(2 * HOUR_MS),
    });

    const service = await start();

    const broken = service.getStatus('esphome');
    expect(broken).toEqual({
      channel: 'esphome',
      // The name lives in the feed we could not read, so the slug stands in.
      channelName: 'esphome',
      status: 'none',
      updatedAt: iso(),
    });
    expect(service.getStatus('home-assistant')).toMatchObject({
      status: 'upcoming',
      title: 'Unaffected',
    });
    // The failure is contained: every channel still has an entry.
    expect(service.getAll()).toHaveLength(CHANNELS.length);
  });

  it('survives a missing YOUTUBE_API_KEY and still serves every channel', async () => {
    const service = createService({});

    await expect(start(service)).resolves.toBe(service);
    await jest.advanceTimersByTimeAsync(TICK_MS);

    const all = service.getAll();
    expect(all).toHaveLength(CHANNELS.length);
    expect(all.every((info) => info.status === 'none')).toBe(true);
    // Without a key the API call throws before any request goes out.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a known slug and rejects an unknown one', async () => {
    yt.addStream('home-assistant', 'vid-known', {
      title: 'Known channel stream',
      scheduledStartTime: iso(2 * HOUR_MS),
    });
    const service = await start();

    expect(service.getStatus('home-assistant')).toMatchObject({
      channel: 'home-assistant',
      channelName: 'Home Assistant',
      title: 'Known channel stream',
    });
    expect(() => service.getStatus('nope')).toThrow(NotFoundException);
    // The slug is not repeated back: it is attacker controlled, and a consumer
    // rendering the message would inherit whatever was in it.
    expect(() => service.getStatus('<img src=x onerror=alert(1)>')).toThrow(
      'Unknown channel',
    );
    expect(() => service.getStatus('<img src=x onerror=alert(1)>')).not.toThrow(
      /img src/,
    );
  });

  it('batches videos.list in chunks of 50 and requests each video ID once', async () => {
    const ids = Array.from({ length: 55 }, (_, i) => `vid-${i}`);
    for (const id of ids) {
      yt.addUpload('home-assistant', id);
    }
    // The feed repeats a few entries; they must not cost extra quota.
    yt.repeatInFeed('home-assistant', 'vid-0');
    yt.repeatInFeed('home-assistant', 'vid-1');

    await start();

    const calls = videosListCalls();
    expect(calls).toHaveLength(2);
    const batches = calls.map(idsRequestedIn);
    expect(batches.map((batch) => batch.length)).toEqual([50, 5]);
    const requested = batches.flat();
    expect(requested).toHaveLength(new Set(requested).size);
    expect(new Set(requested)).toEqual(new Set(ids));
    // Feeds are free, so exactly one feed request per channel is expected.
    expect(callsTo('/feeds/videos.xml')).toHaveLength(CHANNELS.length);
    for (const call of callsTo('/feeds/videos.xml')) {
      expect(String(call[0]).startsWith(feedUrl(''))).toBe(true);
    }
  });

  describe('channel display names', () => {
    it.each([
      ['an apostrophe', 'Nabu Casa&#39;s Channel', "Nabu Casa's Channel"],
      ['an ampersand', 'Home &amp; Away', 'Home & Away'],
      ['a quote', '&quot;Smart&quot; Home', '"Smart" Home'],
      ['angle brackets', '&lt;Home&gt;', '<Home>'],
      ['a hex character reference', 'Caf&#xe9; Assistant', 'Café Assistant'],
      ['an escaped entity', 'Ampersand &amp;amp; Co', 'Ampersand &amp; Co'],
    ])(
      'decodes %s in a feed title',
      async (_description, encoded, expected) => {
        // Atom escapes markup, so the raw match would otherwise reach clients.
        yt.setFeedTitle('esphome', encoded);
        const service = await start();

        expect(service.getStatus('esphome').channelName).toBe(expected);
      },
    );

    it("reports the channel-level <title> of the channel's own feed", async () => {
      const service = await start();

      const esphome = service.getStatus('esphome');
      expect(esphome.channelName).toBe('ESPHome');
      expect(esphome.channelName).not.toBe(esphome.channel);
      expect(service.getAll().map((info) => info.channelName)).toEqual(
        CHANNELS.map((c) => FEED_TITLES[c.slug]),
      );
    });

    it('falls back to the slug for every channel until the first discovery sweep lands', () => {
      const service = createService();

      const all = service.getAll();

      expect(all.map((info) => info.channelName)).toEqual(
        CHANNELS.map((c) => c.slug),
      );
      // Never blank: the field is served from the very first request onwards.
      expect(all.every((info) => Boolean(info.channelName))).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the slug for a channel whose feed fetch fails, leaving the other names intact', async () => {
      yt.breakFeed('music-assistant');

      const service = await start();

      expect(service.getStatus('music-assistant').channelName).toBe(
        'music-assistant',
      );
      expect(service.getStatus('home-assistant').channelName).toBe(
        'Home Assistant',
      );
      expect(service.getStatus('esphome').channelName).toBe('ESPHome');
      expect(service.getStatus('open-home-foundation').channelName).toBe(
        'Open Home Foundation',
      );
    });

    it('picks up a rebrand on the next discovery sweep', async () => {
      yt.addStream('esphome', 'vid-upcoming', {
        title: 'ESPHome 2026.8',
        scheduledStartTime: iso(4 * HOUR_MS),
      });
      const service = await start();
      expect(service.getStatus('esphome').channelName).toBe('ESPHome');

      // Only the name changes, so the feed fingerprint is unchanged and no
      // re-classification happens — the new name must land regardless.
      yt.setFeedTitle('esphome', 'ESPHome by Open Home Foundation');
      await jest.advanceTimersByTimeAsync(DISCOVERY_MS);

      expect(service.getStatus('esphome')).toMatchObject({
        channelName: 'ESPHome by Open Home Foundation',
        status: 'upcoming',
        title: 'ESPHome 2026.8',
      });
    });

    it('ignores the title of a 200 response that is not an Atom feed, and keeps the tracked stream', async () => {
      yt.addStream('home-assistant', 'vid-upcoming', {
        title: 'Release Party 2026.8',
        scheduledStartTime: iso(4 * HOUR_MS),
      });
      const service = await start();
      const discoveredAt = service.getStatus('home-assistant').updatedAt;

      yt.serveNotAFeed(
        'home-assistant',
        '<!DOCTYPE html><html><head><title>Error 404 (Not Found)</title>' +
          '</head><body>Sorry, that page does not exist.</body></html>',
      );
      await jest.advanceTimersByTimeAsync(DISCOVERY_MS);

      // A 200 carrying an error page is a failed fetch, not an empty channel:
      // its <title> is not the channel's name and nothing gets evicted.
      expect(service.getStatus('home-assistant')).toEqual({
        channel: 'home-assistant',
        channelName: 'Home Assistant',
        status: 'upcoming',
        title: 'Release Party 2026.8',
        url: 'https://www.youtube.com/watch?v=vid-upcoming',
        startTime: iso(4 * HOUR_MS),
        updatedAt: discoveredAt,
      });
    });
  });

  describe('the feed fingerprint cache', () => {
    it('spends no extra videos.list quota on a sweep over an unchanged feed', async () => {
      yt.addStream('home-assistant', 'vid-upcoming', {
        scheduledStartTime: iso(4 * HOUR_MS),
      });
      await start();
      const classifications = videosListCalls().length;
      const feedFetches = callsTo('/feeds/videos.xml').length;
      expect(classifications).toBe(1);

      await jest.advanceTimersByTimeAsync(DISCOVERY_MS);

      expect(videosListCalls()).toHaveLength(classifications);
      // The feed itself costs no quota, so it is still re-fetched every sweep.
      expect(callsTo('/feeds/videos.xml')).toHaveLength(
        feedFetches + CHANNELS.length,
      );
    });

    it('re-classifies when a new entry appears in the feed', async () => {
      yt.addStream('home-assistant', 'vid-first', {
        title: 'Already known',
        scheduledStartTime: iso(4 * HOUR_MS),
      });
      const service = await start();
      const classifications = videosListCalls().length;

      yt.addStream('home-assistant', 'vid-sooner', {
        title: 'Newly scheduled',
        scheduledStartTime: iso(1 * HOUR_MS),
      });
      await jest.advanceTimersByTimeAsync(DISCOVERY_MS);

      expect(videosListCalls()).toHaveLength(classifications + 1);
      expect(service.getStatus('home-assistant')).toMatchObject({
        status: 'upcoming',
        title: 'Newly scheduled',
        startTime: iso(1 * HOUR_MS),
      });
    });

    it("re-classifies when an entry's <updated> changes, catching a retitled stream", async () => {
      yt.addStream('home-assistant', 'vid-upcoming', {
        title: 'Release Party 2026.8',
        scheduledStartTime: iso(4 * HOUR_MS),
      });
      const service = await start();
      const classifications = videosListCalls().length;

      // A retitle alone is invisible to us: the feed fingerprint is unchanged,
      // so the sweep is skipped and the stale title stands.
      yt.setTitle('vid-upcoming', 'Release Party 2026.9');
      await jest.advanceTimersByTimeAsync(DISCOVERY_MS);
      expect(videosListCalls()).toHaveLength(classifications);
      expect(service.getStatus('home-assistant').title).toBe(
        'Release Party 2026.8',
      );

      // YouTube bumps <updated> for that edit, which is what we key on.
      yt.bumpFeedUpdated('vid-upcoming');
      await jest.advanceTimersByTimeAsync(DISCOVERY_MS);

      expect(videosListCalls()).toHaveLength(classifications + 1);
      expect(service.getStatus('home-assistant').title).toBe(
        'Release Party 2026.9',
      );
    });

    it('retries classification on the next sweep when videos.list failed', async () => {
      yt.addStream('home-assistant', 'vid-upcoming', {
        title: 'Release Party 2026.8',
        scheduledStartTime: iso(4 * HOUR_MS),
      });
      yt.breakVideosList();

      const service = await start();
      const failedAttempts = videosListCalls().length;
      expect(failedAttempts).toBe(1);
      expect(service.getStatus('home-assistant').status).toBe('none');

      // A failed classification must not be cached as "this feed is done".
      yt.repairVideosList();
      await jest.advanceTimersByTimeAsync(DISCOVERY_MS);

      expect(videosListCalls()).toHaveLength(failedAttempts + 1);
      expect(service.getStatus('home-assistant')).toMatchObject({
        status: 'upcoming',
        title: 'Release Party 2026.8',
      });
    });
  });

  describe('updatedAt', () => {
    it('does not advance while a live stream keeps reporting the same state', async () => {
      yt.addStream('home-assistant', 'vid-live', {
        title: 'Ongoing stream',
        scheduledStartTime: iso(-30 * MINUTE_MS),
        actualStartTime: iso(-30 * MINUTE_MS),
      });
      const service = await start();
      const wentLiveAt = service.getStatus('home-assistant').updatedAt;
      expect(wentLiveAt).toBe(iso());

      // Each of these ticks re-queries the live stream and re-derives state.
      await jest.advanceTimersByTimeAsync(6 * TICK_MS);

      expect(service.getStatus('home-assistant').updatedAt).toBe(wentLiveAt);
    });

    it('advances when the reported status changes', async () => {
      yt.addStream('home-assistant', 'vid-soon', {
        scheduledStartTime: iso(5 * MINUTE_MS),
      });
      const service = await start();
      expect(service.getStatus('home-assistant').updatedAt).toBe(iso());

      yt.markLive('vid-soon', iso(5 * MINUTE_MS));
      await jest.advanceTimersByTimeAsync(TICK_MS);

      const info = service.getStatus('home-assistant');
      expect(info.status).toBe('live');
      expect(info.updatedAt).toBe(iso(TICK_MS));
    });

    it('stays stable across a discovery sweep that changes nothing', async () => {
      yt.addStream('home-assistant', 'vid-upcoming', {
        scheduledStartTime: iso(4 * HOUR_MS),
      });
      const service = await start();
      const discoveredAt = service.getStatus('home-assistant').updatedAt;

      await jest.advanceTimersByTimeAsync(DISCOVERY_MS);

      expect(service.getStatus('home-assistant').updatedAt).toBe(discoveredAt);
    });
  });

  describe('a video that disappears from videos.list', () => {
    /** Deleted, privated or made members-only: the API just omits the ID. */
    it('untracks a live stream that vanishes, clearing the channel status', async () => {
      yt.addStream('home-assistant', 'vid-live', {
        scheduledStartTime: iso(-5 * MINUTE_MS),
        actualStartTime: iso(-5 * MINUTE_MS),
      });
      const service = await start();
      expect(service.getStatus('home-assistant').status).toBe('live');

      yt.deleteVideo('vid-live');
      await jest.advanceTimersByTimeAsync(TICK_MS);

      expect(service.getStatus('home-assistant').status).toBe('none');
    });

    it('releases the fast poll cadence instead of polling forever', async () => {
      yt.addStream('home-assistant', 'vid-live', {
        scheduledStartTime: iso(-5 * MINUTE_MS),
        actualStartTime: iso(-5 * MINUTE_MS),
      });
      await start();

      yt.deleteVideo('vid-live');
      // The tick that discovers the video is gone still spends one lookup.
      await jest.advanceTimersByTimeAsync(TICK_MS);
      const afterUntracking = videosListCalls().length;

      // With nothing tracked, later ticks must cost no quota at all.
      await jest.advanceTimersByTimeAsync(12 * TICK_MS);

      expect(videosListCalls()).toHaveLength(afterUntracking);
    });

    it('falls back to another stream on the same channel', async () => {
      yt.addStream('home-assistant', 'vid-live', {
        scheduledStartTime: iso(-5 * MINUTE_MS),
        actualStartTime: iso(-5 * MINUTE_MS),
      });
      yt.addStream('home-assistant', 'vid-next', {
        title: 'Next release party',
        scheduledStartTime: iso(3 * HOUR_MS),
      });
      const service = await start();
      expect(service.getStatus('home-assistant').status).toBe('live');

      yt.deleteVideo('vid-live');
      await jest.advanceTimersByTimeAsync(TICK_MS);

      const info = service.getStatus('home-assistant');
      expect(info.status).toBe('upcoming');
      expect(info.title).toBe('Next release party');
    });

    it('untracks a far-future upcoming stream on the next discovery sweep', async () => {
      // Too far out for the reconcile poller to look at, so only discovery
      // notices it is gone.
      yt.addStream('esphome', 'vid-later', {
        scheduledStartTime: iso(4 * HOUR_MS),
      });
      const service = await start();
      expect(service.getStatus('esphome').status).toBe('upcoming');

      yt.deleteVideo('vid-later');
      await jest.advanceTimersByTimeAsync(5 * MINUTE_MS);

      expect(service.getStatus('esphome').status).toBe('none');
    });

    it('keeps a live stream that merely fell out of the feed window', async () => {
      // Only "upcoming" is evicted for leaving the feed; a live stream is the
      // reconcile poller's to own, since the API is authoritative about it.
      yt.addStream('home-assistant', 'vid-live', {
        scheduledStartTime: iso(-5 * MINUTE_MS),
        actualStartTime: iso(-5 * MINUTE_MS),
      });
      const service = await start();

      yt.removeFromFeed('vid-live');
      await jest.advanceTimersByTimeAsync(5 * MINUTE_MS);

      expect(service.getStatus('home-assistant').status).toBe('live');
    });

    it('keeps tracked state when the lookup fails rather than evicting on an error', async () => {
      yt.addStream('home-assistant', 'vid-live', {
        scheduledStartTime: iso(-5 * MINUTE_MS),
        actualStartTime: iso(-5 * MINUTE_MS),
      });
      const service = await start();

      // A failing request must never be read as "the video is gone".
      yt.breakVideosList();
      await jest.advanceTimersByTimeAsync(TICK_MS);

      expect(service.getStatus('home-assistant').status).toBe('live');
    });
  });
});
