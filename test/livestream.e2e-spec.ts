import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { Channel } from '../src/livestream/livestream.channels';
import { LivestreamModule } from '../src/livestream/livestream.module';

const HOUR_MS = 60 * 60 * 1000;

/**
 * A tracked channel plus the things only the *feed* knows about it.
 *
 * `Channel` is exactly what configuration can express — a handle and a slug.
 * The display name is not configurable: the service reads it from the channel's
 * feed title at runtime. So the fixtures carry the feed title separately, and
 * every `channelName` assertion below is an assertion about the feed.
 */
interface ChannelFixture extends Channel {
  /** Channel-level <title> this channel's feed serves. */
  feedTitle: string;
  /** Serve a non-feed body for this channel, i.e. its feed cannot be read. */
  feedUnreadable?: boolean;
}

/**
 * The tracked channels come from the LIVESTREAM_CHANNELS environment variable,
 * so this suite owns its channel list and hands it to the app through config.
 * Every assertion below therefore describes these fixtures, never whatever the
 * deployment (or the developer's .env) happens to be configured with.
 *
 * Each feed title is deliberately unlike its slug, so an implementation that
 * fell back to the slug could not pass the display-name assertions by accident.
 */
const FIXTURE_CHANNELS: ChannelFixture[] = [
  {
    slug: 'fixture-alpha',
    handle: 'FixtureAlpha',
    feedTitle: 'Fixture Alpha Live',
  },
  {
    slug: 'fixture-bravo',
    handle: 'FixtureBravo',
    feedTitle: 'Bravo Broadcasting Co.',
  },
  {
    slug: 'fixture-charlie',
    handle: 'FixtureCharlie',
    feedTitle: 'Charlie on YouTube',
  },
];

/** A deliberately different list, used to prove the channels come from config. */
const SOLO_CHANNELS: ChannelFixture[] = [
  {
    slug: 'solo-config-channel',
    handle: 'SoloConfigChannel',
    feedTitle: 'The Solo Config Show',
  },
];

/** One healthy channel and one whose feed cannot be read. */
const MIXED_FEED_CHANNELS: ChannelFixture[] = [
  {
    slug: 'readable-feed',
    handle: 'ReadableFeed',
    feedTitle: 'Readable Feed Network',
  },
  {
    slug: 'unreadable-feed',
    handle: 'UnreadableFeed',
    feedTitle: 'Never Reaches The API',
    feedUnreadable: true,
  },
];

const READABLE_FEED_CHANNEL = MIXED_FEED_CHANNELS[0];
const UNREADABLE_FEED_CHANNEL = MIXED_FEED_CHANNELS[1];

/**
 * The service derives a channel's status from its tracked livestreams, so every
 * channel gets a livestream fixture: that makes "discovery has settled" an
 * observable condition over HTTP (no channel is left at the initial "none").
 */
type Scenario = 'upcoming' | 'live' | 'past';
const SCENARIOS: Scenario[] = ['upcoming', 'live', 'past'];

interface Fixture extends ChannelFixture {
  scenario: Scenario;
  channelId: string;
  videoId: string;
  /** The video's title, deliberately unlike the channel's feed title. */
  title: string;
  /** Atom <updated>; the service fingerprints the feed with it. */
  feedUpdated: string;
}

const buildFixtures = (channels: ChannelFixture[], prefix: string): Fixture[] =>
  channels.map((channel, index) => ({
    ...channel,
    scenario: SCENARIOS[index % SCENARIOS.length],
    channelId: `UC${prefix}channel${index}`,
    videoId: `${prefix}video${index}`,
    title: `Test stream on ${channel.slug}`,
    feedUpdated: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
  }));

const FIXTURES = buildFixtures(FIXTURE_CHANNELS, 'test');
const SOLO_FIXTURES = buildFixtures(SOLO_CHANNELS, 'solo');
const MIXED_FEED_FIXTURES = buildFixtures(MIXED_FEED_CHANNELS, 'mixed');

/**
 * The fixture list is built to contain one of each scenario, so a missing one is
 * a broken fixture rather than a runtime possibility — fail loudly here instead
 * of threading undefined through every assertion.
 */
const fixtureFor = (scenario: Scenario): Fixture => {
  const fixture = FIXTURES.find((f) => f.scenario === scenario);
  if (!fixture) {
    throw new Error(`no "${scenario}" fixture configured`);
  }
  return fixture;
};

const UPCOMING = fixtureFor('upcoming');
const LIVE = fixtureFor('live');

/** Scheduled far enough out that the service does not treat it as imminent. */
const scheduledStartTime = new Date(Date.now() + 3 * HOUR_MS).toISOString();
const startedLongAgo = new Date(Date.now() - 2 * HOUR_MS).toISOString();
const endedRecently = new Date(Date.now() - HOUR_MS).toISOString();

const liveStreamingDetailsFor = (scenario: Scenario) => {
  switch (scenario) {
    case 'upcoming':
      return { scheduledStartTime };
    case 'live':
      return {
        scheduledStartTime: startedLongAgo,
        actualStartTime: startedLongAgo,
      };
    case 'past':
      return {
        scheduledStartTime: startedLongAgo,
        actualStartTime: startedLongAgo,
        actualEndTime: endedRecently,
      };
  }
};

/**
 * LIVESTREAM_CHANNELS is a comma-separated list of `handle:slug` pairs, so the
 * config string is derived from the fixture list rather than written out twice.
 */
const toChannelsConfig = (channels: Channel[]): string =>
  channels.map((channel) => `${channel.handle}:${channel.slug}`).join(',');

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Shaped like a real YouTube channel feed:
 *
 * - the channel-level <title> comes before the first <entry> and is the
 *   channel's display name, which is where the served channelName comes from;
 * - each <entry> carries its own <title> (the video's) plus an <updated>, which
 *   the service fingerprints to decide whether the feed changed and a
 *   videos.list classification is worth spending quota on.
 */
const feedResponse = (channelTitle: string, fixtures: Fixture[]) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <title>${channelTitle}</title>
  <link rel="alternate" href="https://www.youtube.com/channel/${fixtures[0]?.channelId ?? ''}"/>
${fixtures
  .map(
    (fixture) =>
      `  <entry><yt:videoId>${fixture.videoId}</yt:videoId>` +
      `<title>${fixture.title}</title>` +
      `<updated>${fixture.feedUpdated}</updated></entry>`,
  )
  .join('\n')}
</feed>`,
    { status: 200, headers: { 'content-type': 'application/atom+xml' } },
  );

/** The <title> of the error page served for an unreadable feed. */
const ERROR_PAGE_TITLE = 'Error 503 (Service Unavailable)!!1';

/**
 * A 200 that is not a feed at all — the shape of a YouTube/proxy error page.
 * The service rejects any body without `<feed`, so this must neither classify
 * as "the channel has no videos" nor donate its <title> as a channel name.
 */
const errorPageResponse = () =>
  new Response(
    `<!doctype html><html><head><title>${ERROR_PAGE_TITLE}</title></head>` +
      `<body><p>503. That's an error.</p></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

const videoItem = (fixture: Fixture) => ({
  id: fixture.videoId,
  snippet: { title: fixture.title, channelId: fixture.channelId },
  liveStreamingDetails: liveStreamingDetailsFor(fixture.scenario),
});

/** Serves the three URL shapes the service talks to; everything else is a hard error. */
const fetchHandlerFor =
  (fixtures: Fixture[]) =>
  async (input: unknown): Promise<Response> => {
    const url = new URL(String(input));

    if (url.hostname === 'www.googleapis.com') {
      if (url.pathname === '/youtube/v3/channels') {
        const handle = url.searchParams.get('forHandle');
        const fixture = fixtures.find((f) => f.handle === handle);
        return jsonResponse({
          items: fixture ? [{ id: fixture.channelId }] : [],
        });
      }
      if (url.pathname === '/youtube/v3/videos') {
        const ids = (url.searchParams.get('id') ?? '')
          .split(',')
          .filter(Boolean);
        const items = fixtures
          .filter((f) => ids.includes(f.videoId))
          .map(videoItem);
        return jsonResponse({ items });
      }
    }

    if (
      url.hostname === 'www.youtube.com' &&
      url.pathname === '/feeds/videos.xml'
    ) {
      const channelId = url.searchParams.get('channel_id');
      const owner = fixtures.find((f) => f.channelId === channelId);
      if (!owner) {
        throw new Error(`Unexpected feed request for channel ${channelId}`);
      }
      return owner.feedUnreadable
        ? errorPageResponse()
        : feedResponse(
            owner.feedTitle,
            fixtures.filter((f) => f.channelId === channelId),
          );
    }

    throw new Error(`Unexpected outbound request to ${url.toString()}`);
  };

/** Nest logs provider instantiation failures; keep the expected ones quiet. */
const SILENT_LOGGER = {
  log: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  verbose: () => {},
};

/**
 * Boot the module under test with an explicit LIVESTREAM_CHANNELS value.
 *
 * `ignoreEnvFile` keeps the developer's real .env out of the run, and the
 * loaded factory wins over process.env in ConfigService, so the channel list is
 * exactly the fixture list the caller passes in.
 */
const createApp = async (
  rawChannels: string,
  silent = false,
): Promise<INestApplication> => {
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            YOUTUBE_API_KEY: 'test-key',
            LIVESTREAM_CHANNELS: rawChannels,
          }),
        ],
      }),
      LivestreamModule,
    ],
  });
  if (silent) {
    builder = builder.setLogger(SILENT_LOGGER);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
};

const createAppForChannels = (
  channels: ChannelFixture[],
): Promise<INestApplication> => createApp(toChannelsConfig(channels));

/** Every outbound RSS feed request the stub has seen. */
const feedRequests = (fetchMock: jest.Mock): string[] =>
  fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes('youtube.com/feeds/videos.xml'));

/**
 * Startup discovery is kicked off without being awaited. Drive the event loop
 * turn by turn until the collection satisfies `settled` instead of sleeping.
 */
const pollUntil = async (
  server: any,
  what: string,
  settled: (entries: any[]) => boolean,
): Promise<void> => {
  for (let turn = 0; turn < 200; turn++) {
    const res = await request(server).get('/livestream');
    if (res.status === 200 && Array.isArray(res.body) && settled(res.body)) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const waitForDiscovery = (
  server: any,
  expectedChannels: number,
): Promise<void> =>
  pollUntil(
    server,
    'startup discovery to populate every channel',
    (entries) =>
      entries.length === expectedChannels &&
      entries.every((entry) => entry.status !== 'none'),
  );

const DOCUMENTED_KEYS = [
  'channel',
  'channelName',
  'status',
  'title',
  'url',
  'startTime',
  'updatedAt',
];

const isIsoTimestamp = (value: unknown): boolean =>
  typeof value === 'string' &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

describe('Livestream (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let fetchMock: jest.Mock;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    fetchMock = jest.fn(fetchHandlerFor(FIXTURES));
    // Stubbed before init() because the service calls the network on startup.
    globalThis.fetch = fetchMock;

    app = await createAppForChannels(FIXTURE_CHANNELS);
    server = app.getHttpServer();

    await waitForDiscovery(server, FIXTURE_CHANNELS.length);
  }, 30_000);

  afterAll(async () => {
    // Clears the discovery/reconcile intervals so Jest can exit cleanly.
    await app?.close();
    globalThis.fetch = originalFetch;
  });

  describe('GET /livestream', () => {
    it('returns one entry per configured channel, in configured order', async () => {
      const res = await request(server).get('/livestream');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(FIXTURE_CHANNELS.length);
      expect(res.body.map((entry: any) => entry.channel)).toEqual(
        FIXTURE_CHANNELS.map((channel) => channel.slug),
      );
    });

    it('describes every channel with the documented entry shape', async () => {
      const res = await request(server).get('/livestream');

      for (const [index, channel] of FIXTURE_CHANNELS.entries()) {
        const entry = res.body[index];
        expect(entry.channel).toBe(channel.slug);
        expect(entry.channelName).toBe(channel.feedTitle);
        expect(['live', 'upcoming', 'past', 'none']).toContain(entry.status);
        expect(isIsoTimestamp(entry.updatedAt)).toBe(true);
        expect(
          Object.keys(entry).filter((key) => !DOCUMENTED_KEYS.includes(key)),
        ).toEqual([]);
        if (entry.status !== 'none') {
          expect(typeof entry.title).toBe('string');
          expect(entry.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
        }
      }
    });

    it('names each channel with the title from its feed, not with its slug', async () => {
      const res = await request(server).get('/livestream');

      for (const [index, channel] of FIXTURE_CHANNELS.entries()) {
        const entry = res.body[index];
        // The fixtures' feed titles are nothing like their slugs, so a service
        // still serving the slug fallback cannot pass this.
        expect(entry.channelName).toBe(channel.feedTitle);
        expect(entry.channelName).not.toBe(channel.slug);
        // The channel's <title> is not the <title> of an entry in its feed.
        expect(entry.channelName).not.toBe(entry.title);
      }
    });

    it('serves JSON', async () => {
      const res = await request(server).get('/livestream');

      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('reports the same updatedAt while a channel state does not change', async () => {
      const first = await request(server).get('/livestream');
      const second = await request(server).get('/livestream');

      expect(second.body.map((entry: any) => entry.updatedAt)).toEqual(
        first.body.map((entry: any) => entry.updatedAt),
      );
    });
  });

  describe('GET /livestream/:slug', () => {
    it('returns the entry for a known channel, matching the collection', async () => {
      const slug = FIXTURE_CHANNELS[0].slug;

      const all = await request(server).get('/livestream');
      const one = await request(server).get(`/livestream/${slug}`);

      expect(one.status).toBe(200);
      expect(one.body.channel).toBe(slug);
      expect(one.body).toEqual(
        all.body.find((entry: any) => entry.channel === slug),
      );
    });

    it('returns 404 naming the channel when the slug is unknown', async () => {
      const res = await request(server).get('/livestream/not-a-real-channel');

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.statusCode).toBe(404);
      expect(res.body.message).toContain('not-a-real-channel');
    });

    it('returns 404 for a slug containing path traversal characters', async () => {
      const res = await request(server).get(
        '/livestream/..%2F..%2Fetc%2Fpasswd',
      );

      expect(res.status).toBe(404);
      // The decoded path is rejected as an unknown channel, so the request did
      // reach the controller rather than dying in the routing/URL layer.
      expect(res.body.message).toContain('../../etc/passwd');
      expect(res.text).not.toContain('root:');
    });
  });

  describe('RSS-only discovery', () => {
    it('reports a channel with a scheduled stream in its feed as upcoming', async () => {
      expect(UPCOMING).toBeDefined();

      const res = await request(server).get(`/livestream/${UPCOMING.slug}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('upcoming');
      expect(res.body.title).toBe(UPCOMING.title);
      expect(res.body.url).toBe(
        `https://www.youtube.com/watch?v=${UPCOMING.videoId}`,
      );
      expect(res.body.startTime).toBe(scheduledStartTime);
      expect(isIsoTimestamp(res.body.startTime)).toBe(true);
    });

    it('keeps the scheduled startTime once a stream has gone live', async () => {
      expect(LIVE).toBeDefined();

      const res = await request(server).get(`/livestream/${LIVE.slug}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('live');
      expect(res.body.url).toBe(
        `https://www.youtube.com/watch?v=${LIVE.videoId}`,
      );
      expect(res.body.startTime).toBe(startedLongAgo);
    });

    it('discovers streams by reading each channel RSS feed', async () => {
      const feedUrls = feedRequests(fetchMock);

      expect(feedUrls.length).toBeGreaterThanOrEqual(FIXTURE_CHANNELS.length);
      for (const fixture of FIXTURES) {
        expect(
          feedUrls.some((url) =>
            url.includes(`channel_id=${fixture.channelId}`),
          ),
        ).toBe(true);
      }
    });
  });

  describe('the removed WebSub/PubSubHubbub webhook', () => {
    it('is gone: GET /pubsub returns 404', async () => {
      const res = await request(server).get('/pubsub');

      expect(res.status).toBe(404);
    });

    it('is gone: POST /pubsub with an Atom notification body returns 404', async () => {
      const res = await request(server)
        .post('/pubsub')
        .set('content-type', 'application/atom+xml')
        .send(
          '<?xml version="1.0" encoding="UTF-8"?>' +
            '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">' +
            '<entry><yt:videoId>injected</yt:videoId></entry></feed>',
        );

      expect(res.status).toBe(404);
    });

    it('never subscribes to the PubSubHubbub hub', async () => {
      const outbound = fetchMock.mock.calls.map(([input]) => String(input));

      expect(outbound.length).toBeGreaterThan(0);
      expect(
        outbound.filter((url) => url.includes('pubsubhubbub.appspot.com')),
      ).toEqual([]);
    });
  });
});

describe('Livestream channel list from configuration (e2e)', () => {
  let app: INestApplication;
  let server: any;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    globalThis.fetch = jest.fn(fetchHandlerFor(SOLO_FIXTURES));

    app = await createAppForChannels(SOLO_CHANNELS);
    server = app.getHttpServer();

    await waitForDiscovery(server, SOLO_CHANNELS.length);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    globalThis.fetch = originalFetch;
  });

  it('tracks exactly the channels LIVESTREAM_CHANNELS names', async () => {
    const res = await request(server).get('/livestream');

    expect(res.status).toBe(200);
    expect(res.body.map((entry: any) => entry.channel)).toEqual([
      'solo-config-channel',
    ]);
    expect(res.body[0].channelName).toBe(SOLO_CHANNELS[0].feedTitle);
  });

  it('serves the configured channel by its slug', async () => {
    const res = await request(server).get('/livestream/solo-config-channel');

    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('solo-config-channel');
    expect(res.body.status).toBe('upcoming');
  });

  it('returns 404 for a channel this app was not configured with', async () => {
    const res = await request(server).get(
      `/livestream/${FIXTURE_CHANNELS[0].slug}`,
    );

    expect(res.status).toBe(404);
    expect(res.body.message).toContain(FIXTURE_CHANNELS[0].slug);
  });
});

describe('Livestream with an unreadable channel feed (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let fetchMock: jest.Mock;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    fetchMock = jest.fn(fetchHandlerFor(MIXED_FEED_FIXTURES));
    globalThis.fetch = fetchMock;

    app = await createApp(toChannelsConfig(MIXED_FEED_CHANNELS), true);
    server = app.getHttpServer();

    // The broken channel never leaves "none", so waiting for every channel to
    // settle would never finish. Wait instead for the healthy channel to be
    // classified *and* for the broken channel's feed to have been attempted.
    await pollUntil(
      server,
      'the healthy channel to settle and the broken feed to have been read',
      (entries) =>
        entries.length === MIXED_FEED_CHANNELS.length &&
        entries.some(
          (entry) =>
            entry.channel === READABLE_FEED_CHANNEL.slug &&
            entry.status !== 'none',
        ) &&
        feedRequests(fetchMock).some((url) =>
          url.includes(
            `channel_id=${
              MIXED_FEED_FIXTURES.find(
                (f) => f.slug === UNREADABLE_FEED_CHANNEL.slug,
              )?.channelId
            }`,
          ),
        ),
    );
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    globalThis.fetch = originalFetch;
  });

  it('still lists a channel whose feed cannot be read, in the documented shape', async () => {
    const res = await request(server).get('/livestream');

    expect(res.status).toBe(200);
    expect(res.body.map((entry: any) => entry.channel)).toEqual(
      MIXED_FEED_CHANNELS.map((channel) => channel.slug),
    );

    const entry = res.body.find(
      (candidate: any) => candidate.channel === UNREADABLE_FEED_CHANNEL.slug,
    );
    expect(entry).toBeDefined();
    expect(entry.status).toBe('none');
    expect(isIsoTimestamp(entry.updatedAt)).toBe(true);
    expect(
      Object.keys(entry).filter((key) => !DOCUMENTED_KEYS.includes(key)),
    ).toEqual([]);
    // Nothing was discovered, so there is no stream to advertise.
    expect(entry.title).toBeUndefined();
    expect(entry.url).toBeUndefined();
    expect(entry.startTime).toBeUndefined();
  });

  it('falls back to the slug for the name of a channel whose feed cannot be read', async () => {
    const res = await request(server).get(
      `/livestream/${UNREADABLE_FEED_CHANNEL.slug}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.channelName).toBe(UNREADABLE_FEED_CHANNEL.slug);
    // The non-feed body carries a <title> of its own; it is not a channel name.
    expect(res.body.channelName).not.toBe(ERROR_PAGE_TITLE);
  });

  it('keeps serving the channels whose feeds are readable', async () => {
    const res = await request(server).get(
      `/livestream/${READABLE_FEED_CHANNEL.slug}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.channelName).toBe(READABLE_FEED_CHANNEL.feedTitle);
    expect(res.body.status).toBe('upcoming');
  });
});

describe('Livestream with a malformed LIVESTREAM_CHANNELS (e2e)', () => {
  // Only set if a boot unexpectedly succeeds, so afterEach can clean it up.
  let app: INestApplication | undefined;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    app = undefined;
    // A boot that unexpectedly succeeds must not reach the network either.
    globalThis.fetch = jest.fn(async (input: unknown) => {
      throw new Error(`Unexpected outbound request to ${String(input)}`);
    });
  });

  afterEach(async () => {
    // Nothing should be left running if the boot did not fail as expected.
    await app?.close();
    globalThis.fetch = originalFetch;
  });

  /** Assigns `app` only if the boot unexpectedly succeeds, so afterEach can close it. */
  const boot = async (rawChannels: string): Promise<void> => {
    app = await createApp(rawChannels, true);
  };

  it('fails the boot when an entry has no ":" separating handle from slug', async () => {
    await expect(boot('FixtureAlpha')).rejects.toThrow(
      /LIVESTREAM_CHANNELS\[0\] "FixtureAlpha" must be one handle and one slug separated by ":"/,
    );
  });

  it('fails the boot when the slug after the ":" is not URL-safe', async () => {
    await expect(boot('FixtureAlpha:Not A Slug')).rejects.toThrow(
      /LIVESTREAM_CHANNELS\[0\].*slug "Not A Slug" must be lowercase/,
    );
  });

  it('fails the boot rather than serving an empty channel list', async () => {
    await expect(boot(',,')).rejects.toThrow(
      /LIVESTREAM_CHANNELS.*lists no channels/,
    );
  });
});
