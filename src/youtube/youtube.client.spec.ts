import { ConfigService } from '@nestjs/config';

import { feedUrl, watchUrl, YouTubeClient } from './youtube.client';

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

describe('watchUrl', () => {
  it("builds a video's public watch page URL", () => {
    expect(watchUrl('dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
  });
});

describe('YouTubeClient', () => {
  let fetchMock: jest.Mock;
  let originalFetch: typeof globalThis.fetch;

  const clientWith = (
    env: Record<string, string | undefined> = { YOUTUBE_API_KEY: 'test-key' },
  ): YouTubeClient =>
    new YouTubeClient({ get: (key: string) => env[key] } as ConfigService);

  const json = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('fetchChannelFeed', () => {
    it("fetches the channel's feed by its canonical URL", async () => {
      const xml = '<feed><title>A Channel</title></feed>';
      fetchMock.mockResolvedValue(new Response(xml, { status: 200 }));

      await expect(clientWith().fetchChannelFeed('UC-abc')).resolves.toBe(xml);
      expect(String(fetchMock.mock.calls[0][0])).toBe(feedUrl('UC-abc'));
    });

    it('throws on a non-2xx response', async () => {
      fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

      await expect(clientWith().fetchChannelFeed('UC-abc')).rejects.toThrow(
        'Feed request failed: 500',
      );
    });

    it('throws on a 200 that is not an Atom feed', async () => {
      fetchMock.mockResolvedValue(
        new Response('<html>captive portal</html>', { status: 200 }),
      );

      await expect(clientWith().fetchChannelFeed('UC-abc')).rejects.toThrow(
        'Feed response was not an Atom feed',
      );
    });
  });

  describe('channelIdForHandle', () => {
    it('resolves a handle through channels.list', async () => {
      fetchMock.mockResolvedValue(json({ items: [{ id: 'UC-resolved' }] }));

      await expect(clientWith().channelIdForHandle('SomeHandle')).resolves.toBe(
        'UC-resolved',
      );

      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname.endsWith('/youtube/v3/channels')).toBe(true);
      expect(url.searchParams.get('forHandle')).toBe('SomeHandle');
      expect(url.searchParams.get('key')).toBe('test-key');
    });

    it('throws when the API knows no channel for the handle', async () => {
      fetchMock.mockResolvedValue(json({ items: [] }));

      await expect(
        clientWith().channelIdForHandle('NoSuchHandle'),
      ).rejects.toThrow('Channel not found for handle @NoSuchHandle');
    });
  });

  describe('videoDetails', () => {
    it('issues no request at all for an empty ID list', async () => {
      await expect(clientWith().videoDetails([])).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('batches unique IDs into 50-ID videos.list pages', async () => {
      const ids = Array.from({ length: 60 }, (_, i) => `vid-${i}`);
      fetchMock.mockImplementation((input: unknown) => {
        const requested = (
          new URL(String(input)).searchParams.get('id') ?? ''
        ).split(',');
        return Promise.resolve(
          json({ items: requested.map((id) => ({ id })) }),
        );
      });

      // Duplicates collapse before batching, so 60 unique IDs are two pages.
      const items = await clientWith().videoDetails([...ids, ...ids]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(items.map((item) => item.id)).toEqual(ids);
    });

    it('throws without a request when YOUTUBE_API_KEY is not set', async () => {
      await expect(clientWith({}).videoDetails(['vid-1'])).rejects.toThrow(
        'YOUTUBE_API_KEY is not set',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a failed videos.list request with its response body', async () => {
      fetchMock.mockResolvedValue(
        new Response('quota exceeded', {
          status: 403,
          statusText: 'Forbidden',
        }),
      );

      await expect(clientWith().videoDetails(['vid-1'])).rejects.toThrow(
        'YouTube API videos request failed: 403 Forbidden - quota exceeded',
      );
    });
  });
});
