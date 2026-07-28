import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  Channel,
  LIVESTREAM_CHANNELS,
  feedUrl,
  parseChannels,
} from './livestream.channels';

const FORMAT = 'expected a comma-separated list of handle:slug pairs';

describe('parseChannels', () => {
  describe('valid configuration', () => {
    it('parses a single handle:slug pair', () => {
      expect(parseChannels('esphomeio:esphome')).toEqual([
        { slug: 'esphome', handle: 'esphomeio' },
      ]);
    });

    it('parses several pairs and preserves their configured order', () => {
      const channels = parseChannels(
        'esphomeio:esphome,home_assistant:home-assistant,MusicAssistant:music-assistant',
      );

      expect(channels).toEqual([
        { slug: 'esphome', handle: 'esphomeio' },
        { slug: 'home-assistant', handle: 'home_assistant' },
        { slug: 'music-assistant', handle: 'MusicAssistant' },
      ]);
    });

    it('trims whitespace around entries, handles and slugs', () => {
      expect(
        parseChannels(
          '  home_assistant : home-assistant  ,\n\tesphomeio\t:\tesphome\n',
        ),
      ).toEqual([
        { slug: 'home-assistant', handle: 'home_assistant' },
        { slug: 'esphome', handle: 'esphomeio' },
      ]);
    });

    it.each([
      ['a single leading "@"', '@ESPHome:esphome'],
      ['repeated leading "@"', '@@ESPHome:esphome'],
      ['a leading "@" inside padding', '  @ESPHome  :  esphome  '],
    ])('strips %s from a handle', (_description, raw) => {
      expect(parseChannels(raw)).toEqual([
        { slug: 'esphome', handle: 'ESPHome' },
      ]);
    });

    it.each([
      ['a dot', 'esp.home'],
      ['an underscore', 'home_assistant'],
      ['a hyphen', 'home-assistant'],
      ['digits', 'esp32home'],
      ['mixed case', 'OpenHomeFndn'],
    ])('accepts a handle containing %s', (_description, handle) => {
      const [channel] = parseChannels(`${handle}:some-slug`);

      expect(channel.handle).toBe(handle);
    });

    it.each([
      ['a single word', 'esphome'],
      ['several hyphen-separated words', 'open-home-foundation'],
      ['digits only', '123'],
      ['letters and digits', 'esp32-home'],
    ])('accepts a slug that is %s', (_description, slug) => {
      const [channel] = parseChannels(`esphomeio:${slug}`);

      expect(channel.slug).toBe(slug);
    });

    it('tolerates a trailing comma', () => {
      expect(parseChannels('esphomeio:esphome,')).toEqual([
        { slug: 'esphome', handle: 'esphomeio' },
      ]);
    });

    it('tolerates a doubled comma between entries', () => {
      expect(
        parseChannels('esphomeio:esphome,,home_assistant:home-assistant'),
      ).toEqual([
        { slug: 'esphome', handle: 'esphomeio' },
        { slug: 'home-assistant', handle: 'home_assistant' },
      ]);
    });

    it('returns objects with exactly the slug and handle keys, normalized', () => {
      const [channel] = parseChannels('  @Home_Assistant : home-assistant ');

      expect(Object.keys(channel).sort()).toEqual(['handle', 'slug']);
      expect(channel).toEqual({
        slug: 'home-assistant',
        handle: 'Home_Assistant',
      });
    });
  });

  describe('invalid configuration', () => {
    it.each<[string, string | undefined, string]>([
      [
        'the variable is unset',
        undefined,
        `LIVESTREAM_CHANNELS is not set: ${FORMAT}`,
      ],
      // Set-but-blank is reported distinctly from unset, so an operator who did
      // set the variable is not sent looking for a missing one. Blank,
      // whitespace and comma-only values are the same mistake, so they share
      // one message.
      [
        'the variable is set to an empty string',
        '',
        `LIVESTREAM_CHANNELS is set but lists no channels: ${FORMAT}`,
      ],
      [
        'the variable holds only whitespace',
        '   \n\t ',
        'LIVESTREAM_CHANNELS is set but lists no channels',
      ],
      [
        'the value holds only commas',
        ',,,',
        `LIVESTREAM_CHANNELS is set but lists no channels: ${FORMAT}`,
      ],
    ])('throws when %s', (_description, raw, message) => {
      expect(() => parseChannels(raw)).toThrow(message);
    });

    it.each([
      ['there is no ":" at all', 'home-assistant'],
      ['an entry has two colons', 'esphomeio:esphome:extra'],
      ['an entry has three colons', 'a:b:c:d'],
      ['an entry is a bare handle among valid pairs', 'esphomeio'],
    ])('throws when %s', (_description, raw) => {
      expect(() => parseChannels(raw)).toThrow(
        `LIVESTREAM_CHANNELS[0] "${raw}" must be one handle and one slug separated by ":" — ${FORMAT}`,
      );
    });

    it.each([
      ['a full channel URL', 'https://youtube.com/@esphome:esphome'],
      ['a URL with no path', 'https://youtube.com:esphome'],
      ['an http URL', 'http://youtube.com/@esphome:esphome'],
    ])('names the real mistake when an entry is %s', (_description, raw) => {
      // A URL carries its own colon, so it must not be reported as a colon-count
      // problem — that would send the operator after the wrong thing.
      expect(() => parseChannels(raw)).toThrow(
        `LIVESTREAM_CHANNELS[0] "${raw}" looks like a URL — use the bare handle and slug`,
      );
    });

    it.each([
      ['an empty handle before the ":"', ':home-assistant'],
      ['a whitespace-only handle before the ":"', '   :home-assistant'],
      // The entry is trimmed before it is quoted back, so the padding is gone.
    ])('throws on %s', (_description, raw) => {
      expect(() => parseChannels(raw)).toThrow(
        `LIVESTREAM_CHANNELS[0] "${raw.trim()}" has no handle before the ":"`,
      );
    });

    it.each([
      ['only "@"', '@:home-assistant'],
      ['only "@" characters', '@@@:home-assistant'],
    ])('distinguishes a handle that is %s from a missing one', (
      _description,
      raw,
    ) => {
      expect(() => parseChannels(raw)).toThrow(
        `LIVESTREAM_CHANNELS[0] "${raw}" handle must name a channel, not just "@"`,
      );
    });

    it.each([
      ['a single dot', '.:home-assistant'],
      ['dots only', '...:home-assistant'],
      ['hyphens only', '--:home-assistant'],
      ['an underscore only', '_:home-assistant'],
    ])('rejects a handle of punctuation alone (%s)', (_description, raw) => {
      expect(() => parseChannels(raw)).toThrow('must be a bare handle');
    });

    it.each([
      ['an empty slug after the ":"', 'esphomeio:'],
      ['a whitespace-only slug after the ":"', 'esphomeio:   '],
    ])('throws on %s', (_description, raw) => {
      expect(() => parseChannels(raw)).toThrow(
        `LIVESTREAM_CHANNELS[0] "${raw.trimEnd()}" has no slug after the ":"`,
      );
    });

    it.each([
      ['a schemeless channel URL', 'youtube.com/@esphome', 'esphome'],
      ['an inner "@"', 'esp@home', 'esphome'],
      ['a space', 'home assistant', 'home-assistant'],
      ['a slash', 'esphome/videos', 'esphome'],
      ['a plus sign', 'esp+home', 'esphome'],
    ])(
      'throws when a handle is %s rather than a bare handle',
      (_description, handle, slug) => {
        expect(() => parseChannels(`${handle}:${slug}`)).toThrow(
          `LIVESTREAM_CHANNELS[0] "${handle}:${slug}" handle "${handle}" must be a bare handle — letters, digits, dots, underscores and hyphens only, not a URL`,
        );
      },
    );

    it.each([
      ['uppercase letters', 'Home-Assistant'],
      ['an underscore', 'home_assistant'],
      ['an inner space', 'home assistant'],
      ['a leading hyphen', '-home-assistant'],
      ['a trailing hyphen', 'home-assistant-'],
      ['a double hyphen', 'home--assistant'],
      ['a dot', 'home.assistant'],
      ['a slash', 'home/assistant'],
      ['only a hyphen', '-'],
      ['non-ASCII letters', 'hogar-inteligente\u0301'],
    ])(
      'throws when a slug contains %s because the slug appears in the API path',
      (_description, slug) => {
        expect(() => parseChannels(`home_assistant:${slug}`)).toThrow(
          `LIVESTREAM_CHANNELS[0] "home_assistant:${slug}" slug "${slug}" must be lowercase letters, digits and single hyphens — it appears in the API path`,
        );
      },
    );

    it('throws when two entries declare the same slug, naming the slug', () => {
      expect(() =>
        parseChannels('esphomeio:esphome,esphome_backup:esphome'),
      ).toThrow('LIVESTREAM_CHANNELS has a duplicate slug "esphome"');
    });

    it('throws when two entries point at the same handle, naming the handle', () => {
      // Otherwise one channel is polled twice and served under two slugs.
      expect(() =>
        parseChannels('esphomeio:esphome,esphomeio:esphome-mirror'),
      ).toThrow(
        'LIVESTREAM_CHANNELS has two channels pointing at the same handle "esphomeio"',
      );
    });

    it('treats handles differing only in case as the same channel', () => {
      // YouTube handles are case-insensitive.
      expect(() =>
        parseChannels('ESPHomeIO:esphome,esphomeio:esphome-mirror'),
      ).toThrow(
        'LIVESTREAM_CHANNELS has two channels pointing at the same handle "esphomeio"',
      );
    });

    it('identifies the offending entry by its index within the list', () => {
      expect(() =>
        parseChannels('esphomeio:esphome,home_assistant:Home_Assistant'),
      ).toThrow(
        'LIVESTREAM_CHANNELS[1] "home_assistant:Home_Assistant" slug "Home_Assistant"',
      );
    });

    it('numbers entries after a doubled comma by their surviving position', () => {
      // The empty segment is dropped before indexing, so the third written
      // entry is reported as index 1.
      expect(() => parseChannels('esphomeio:esphome,,nope')).toThrow(
        'LIVESTREAM_CHANNELS[1] "nope"',
      );
    });

    it('fails on the first invalid entry rather than collecting every problem', () => {
      expect(() => parseChannels('esphomeio:BAD,also bad:worse slug')).toThrow(
        'LIVESTREAM_CHANNELS[0] "esphomeio:BAD" slug "BAD"',
      );
    });
  });
});

describe('feedUrl', () => {
  it('builds the canonical YouTube RSS feed URL for a channel ID', () => {
    expect(feedUrl('UCbBg8TgHNMV1Z6qYrqbUlXA')).toBe(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCbBg8TgHNMV1Z6qYrqbUlXA',
    );
  });

  it('places the channel ID in the only query parameter, channel_id', () => {
    const url = new URL(feedUrl('UC_test-123'));

    expect(url.origin + url.pathname).toBe(
      'https://www.youtube.com/feeds/videos.xml',
    );
    expect(url.searchParams.get('channel_id')).toBe('UC_test-123');
    expect([...url.searchParams.keys()]).toEqual(['channel_id']);
  });
});

describe('LIVESTREAM_CHANNELS', () => {
  it('is a symbol DI token rather than a channel list', () => {
    expect(typeof LIVESTREAM_CHANNELS).toBe('symbol');
    expect(LIVESTREAM_CHANNELS.toString()).toContain('LIVESTREAM_CHANNELS');
  });
});

describe('the LIVESTREAM_CHANNELS value shipped in .env.example', () => {
  // Read the committed example rather than duplicating the value here, so the
  // documented default and this test cannot drift apart.
  const readEnvExample = (key: string): string | undefined => {
    const file = readFileSync(
      join(__dirname, '..', '..', '.env.example'),
      'utf8',
    );
    const line = file
      .split('\n')
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.startsWith(`${key}=`));
    if (line === undefined) return undefined;

    const value = line.slice(line.indexOf('=') + 1).trim();
    // .env files often wrap the value in quotes; strip one matching pair.
    return /^'.*'$/.test(value) || /^".*"$/.test(value)
      ? value.slice(1, -1)
      : value;
  };

  let channels: Channel[];

  beforeAll(() => {
    channels = parseChannels(readEnvExample('LIVESTREAM_CHANNELS'));
  });

  it('parses into the four Open Home Foundation projects', () => {
    expect(
      [...channels].sort((a, b) => a.slug.localeCompare(b.slug)),
    ).toEqual([
      { slug: 'esphome', handle: 'esphomeio' },
      { slug: 'home-assistant', handle: 'home_assistant' },
      { slug: 'music-assistant', handle: 'musicassistantio' },
      { slug: 'open-home-foundation', handle: 'OpenHomeFndn' },
    ]);
  });
});
