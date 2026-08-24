import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Canonical YouTube channel RSS feed URL — the discovery source for livestream
 * state. Fetching it costs no YouTube Data API quota, unlike the videos.list
 * lookup that classifies the videos it returns.
 */
export const feedUrl = (channelId: string): string =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

/** A video's public watch page. */
export const watchUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${videoId}`;

/**
 * The parts of a YouTube Data API list item this client's consumers read.
 *
 * Only the fields we request a `part` for are modelled, and everything but `id`
 * is optional: a video that is not a broadcast has no `liveStreamingDetails`,
 * and a broadcast carries only the timestamps its lifecycle has reached.
 */
export interface YouTubeItem {
  id: string;
  snippet?: {
    title?: string;
    channelId?: string;
  };
  liveStreamingDetails?: {
    scheduledStartTime?: string;
    actualStartTime?: string;
    actualEndTime?: string;
  };
}

/** A YouTube Data API list response, pared down to what we read. */
interface YouTubeListResponse {
  items?: YouTubeItem[];
}

const API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * The low-level YouTube surfaces: the Data API (channels.list / videos.list)
 * and the free per-channel RSS feed. Consumers get validated payloads or a
 * thrown error — never a half-trusted response — so every feature reading from
 * YouTube shares one place where the key handling and transport can change.
 */
@Injectable()
export class YouTubeClient {
  constructor(private readonly config: ConfigService) {}

  /** Fetch a channel's RSS feed and return its raw XML (free, no quota). */
  async fetchChannelFeed(channelId: string): Promise<string> {
    const res = await fetch(feedUrl(channelId), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Feed request failed: ${res.status}`);
    }
    const xml = await res.text();
    // A 200 carrying something other than the feed (an error page, a proxy
    // interstitial) would otherwise read as "this channel has no videos" and
    // evict tracked streams, and its <title> would be served as the channel
    // name. Treat it as a failed fetch so prior state survives instead.
    if (!xml.includes('<feed')) {
      throw new Error('Feed response was not an Atom feed');
    }
    return xml;
  }

  /** Resolve a handle to its channel ID (UC…) via channels.list. */
  async channelIdForHandle(handle: string): Promise<string> {
    const data = await this.apiGet('channels', {
      part: 'id',
      forHandle: handle,
    });
    const id: string | undefined = data.items?.[0]?.id;
    if (!id) {
      throw new Error(`Channel not found for handle @${handle}`);
    }
    return id;
  }

  /**
   * Classify videos via videos.list, batched to the API's 50-ID page size.
   * IDs the API will not serve — deleted, privated or made members-only — are
   * silently absent from the result, not errors.
   */
  async videoDetails(videoIds: string[]): Promise<YouTubeItem[]> {
    const unique = [...new Set(videoIds)];
    if (unique.length === 0) {
      return [];
    }
    const items: YouTubeItem[] = [];
    for (let i = 0; i < unique.length; i += 50) {
      const data = await this.apiGet('videos', {
        part: 'snippet,liveStreamingDetails',
        id: unique.slice(i, i + 50).join(','),
      });
      items.push(...(data.items ?? []));
    }
    return items;
  }

  private async apiGet(
    path: string,
    params: Record<string, string>,
  ): Promise<YouTubeListResponse> {
    const key = this.config.get<string>('YOUTUBE_API_KEY');
    if (!key) {
      throw new Error('YOUTUBE_API_KEY is not set');
    }
    const url = new URL(`${API_BASE}/${path}`);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    url.searchParams.set('key', key);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `YouTube API ${path} request failed: ${res.status} ${res.statusText}` +
          (body ? ` - ${body}` : ''),
      );
    }
    // Asserted rather than validated: the response is untrusted JSON, and every
    // field YouTubeListResponse declares is optional, so reads narrow anyway.
    return (await res.json()) as YouTubeListResponse;
  }
}
