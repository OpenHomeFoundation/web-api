import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Channel, CHANNELS } from './livestream.channels';

export type LivestreamStatus = 'live' | 'upcoming' | 'past' | 'none';

export interface LivestreamInfo {
  /** Channel slug, e.g. "home-assistant". */
  channel: string;
  /** Human-friendly channel name. */
  channelName: string;
  status: LivestreamStatus;
  title?: string;
  url?: string;
  /** ISO 8601 scheduled start time; present when status is "upcoming". */
  startTime?: string;
  /** ISO 8601 timestamp of when the data was last fetched from YouTube. */
  fetchedAt: string;
}

interface SearchResult {
  videoId: string;
  title: string;
}

interface CacheEntry {
  info: LivestreamInfo;
  cachedAt: number;
}

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const CACHE_TTL_MS = 5 * 60 * 1000;
const PAST_WINDOW_MS = 24 * 60 * 60 * 1000;

const watchUrl = (videoId: string) =>
  `https://www.youtube.com/watch?v=${videoId}`;

@Injectable()
export class LivestreamService {
  private readonly logger = new Logger(LivestreamService.name);
  private readonly channelsBySlug = new Map(
    CHANNELS.map((c) => [c.slug, c] as const),
  );
  private readonly cache = new Map<string, CacheEntry>();
  private readonly channelIds = new Map<string, string>();
  private readonly refreshing = new Map<string, Promise<LivestreamInfo>>();

  constructor(private readonly config: ConfigService) {}

  async getAll(): Promise<LivestreamInfo[]> {
    return Promise.all(CHANNELS.map((channel) => this.getStatus(channel.slug)));
  }

  async getStatus(slug: string): Promise<LivestreamInfo> {
    const channel = this.channelsBySlug.get(slug);
    if (!channel) {
      throw new NotFoundException(`Unknown channel "${slug}"`);
    }

    const cached = this.cache.get(slug);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.info;
    }

    let pending = this.refreshing.get(slug);
    if (!pending) {
      pending = this.refresh(channel).finally(() =>
        this.refreshing.delete(slug),
      );
      this.refreshing.set(slug, pending);
    }

    try {
      return await pending;
    } catch (err) {
      if (cached) {
        this.logger.warn(
          `Refresh failed for ${slug}, serving stale data: ${err}`,
        );
        return cached.info;
      }
      this.logger.error(
        `Failed to fetch livestream status for ${slug}: ${err}`,
      );
      throw new ServiceUnavailableException(
        'Unable to fetch livestream status from YouTube',
      );
    }
  }

  private async refresh(channel: Channel): Promise<LivestreamInfo> {
    const channelId = await this.resolveChannelId(channel);
    const base = {
      channel: channel.slug,
      channelName: channel.name,
      fetchedAt: new Date().toISOString(),
    };

    const [live] = await this.search(channelId, 'live', 1);
    if (live) {
      return this.setCache(channel.slug, {
        ...base,
        status: 'live',
        title: live.title,
        url: watchUrl(live.videoId),
      });
    }

    const upcoming = await this.search(channelId, 'upcoming');
    if (upcoming.length > 0) {
      const details = await this.videoDetails(upcoming.map((v) => v.videoId));
      const next = details
        .map((d: any) => ({
          videoId: d.id as string,
          title: d.snippet?.title as string,
          start: d.liveStreamingDetails?.scheduledStartTime as
            | string
            | undefined,
        }))
        .filter((d) => d.start)
        .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!))[0];
      if (next) {
        return this.setCache(channel.slug, {
          ...base,
          status: 'upcoming',
          title: next.title,
          url: watchUrl(next.videoId),
          startTime: next.start,
        });
      }
    }

    const [completed] = await this.search(channelId, 'completed', 1);
    if (completed) {
      const [details] = await this.videoDetails([completed.videoId]);
      const endedAt: string | undefined =
        details?.liveStreamingDetails?.actualEndTime;
      if (endedAt && Date.now() - Date.parse(endedAt) <= PAST_WINDOW_MS) {
        return this.setCache(channel.slug, {
          ...base,
          status: 'past',
          title: details.snippet?.title ?? completed.title,
          url: watchUrl(completed.videoId),
        });
      }
    }

    return this.setCache(channel.slug, { ...base, status: 'none' });
  }

  private setCache(slug: string, info: LivestreamInfo): LivestreamInfo {
    this.cache.set(slug, { info, cachedAt: Date.now() });
    return info;
  }

  private async resolveChannelId(channel: Channel): Promise<string> {
    const cached = this.channelIds.get(channel.slug);
    if (cached) {
      return cached;
    }
    const data = await this.apiGet('channels', {
      part: 'id',
      forHandle: channel.handle,
    });
    const id: string | undefined = data.items?.[0]?.id;
    if (!id) {
      throw new Error(`Channel not found for handle @${channel.handle}`);
    }
    this.channelIds.set(channel.slug, id);
    return id;
  }

  private async search(
    channelId: string,
    eventType: 'live' | 'upcoming' | 'completed',
    maxResults = 5,
  ): Promise<SearchResult[]> {
    const data = await this.apiGet('search', {
      part: 'snippet',
      channelId,
      eventType,
      type: 'video',
      order: 'date',
      maxResults: String(maxResults),
    });
    return (data.items ?? []).map((item: any) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
    }));
  }

  private async videoDetails(videoIds: string[]): Promise<any[]> {
    if (videoIds.length === 0) {
      return [];
    }
    const data = await this.apiGet('videos', {
      part: 'snippet,liveStreamingDetails',
      id: videoIds.join(','),
    });
    return data.items ?? [];
  }

  private async apiGet(
    path: string,
    params: Record<string, string>,
  ): Promise<any> {
    const key = this.config.get<string>('YOUTUBE_API_KEY');
    if (!key) {
      throw new Error('YOUTUBE_API_KEY is not set');
    }
    const url = new URL(`${API_BASE}/${path}`);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    url.searchParams.set('key', key);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`YouTube API ${path} request failed: ${res.status}`);
    }
    return res.json();
  }
}
