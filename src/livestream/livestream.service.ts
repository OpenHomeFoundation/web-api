import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Channel, CHANNELS, feedUrl } from './livestream.channels';

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
  /** ISO 8601 timestamp of when this channel's state was last updated. */
  updatedAt: string;
}

/** A livestream video we are tracking the state of. */
interface TrackedVideo {
  videoId: string;
  title: string;
  status: LivestreamStatus;
  scheduledStartTime?: string;
  actualEndTime?: string;
  updatedAt: number;
}

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const PAST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Re-scan channels' RSS feeds to discover newly scheduled/published videos. */
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** Base cadence for transition polling (used when a stream is live/imminent). */
const RECONCILE_TICK_MS = 10 * 1000;
/** When idle, only reconcile every Nth tick (10s * 6 = 60s). */
const IDLE_TICKS = 6;
/** Treat an upcoming stream as "imminent" within this window of its start. */
const SOON_WINDOW_MS = 15 * 60 * 1000;

const watchUrl = (videoId: string) =>
  `https://www.youtube.com/watch?v=${videoId}`;

const videoIdPattern = /<yt:videoId>([^<]+)<\/yt:videoId>/g;

const stackOf = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

@Injectable()
export class LivestreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LivestreamService.name);
  private readonly channelsBySlug = new Map(
    CHANNELS.map((c) => [c.slug, c] as const),
  );
  /** Derived, ready-to-serve status per channel slug. */
  private readonly state = new Map<string, LivestreamInfo>();
  /** Tracked livestream videos per channel slug. */
  private readonly tracked = new Map<string, Map<string, TrackedVideo>>();
  private readonly channelIds = new Map<string, string>();
  private readonly slugByChannelId = new Map<string, string>();
  /** In-flight channel-ID resolutions, to de-duplicate concurrent lookups. */
  private readonly channelIdPromises = new Map<string, Promise<string>>();
  /** Stable timestamp used for channels that have no state yet. */
  private readonly startedAt = new Date().toISOString();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private discoveryTimer?: ReturnType<typeof setInterval>;
  private tickCount = 0;
  private discoveryRunning = false;
  private reconcileRunning = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // Seed initial state from each channel's (free) RSS feed so we are not
    // blank until the first push arrives.
    void this.discovery();
    this.discoveryTimer = setInterval(
      () => void this.discovery(),
      DISCOVERY_INTERVAL_MS,
    );
    this.reconcileTimer = setInterval(() => void this.tick(), RECONCILE_TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
    }
  }

  getAll(): LivestreamInfo[] {
    return CHANNELS.map((channel) => this.readState(channel));
  }

  getStatus(slug: string): LivestreamInfo {
    const channel = this.channelsBySlug.get(slug);
    if (!channel) {
      throw new NotFoundException(`Unknown channel "${slug}"`);
    }
    return this.readState(channel);
  }

  /** Resolve a channel's YouTube channel ID (UC…), caching the result. */
  async resolveChannelId(channel: Channel): Promise<string> {
    const cached = this.channelIds.get(channel.slug);
    if (cached) {
      return cached;
    }
    // De-duplicate concurrent resolutions (e.g. discovery + subscription on
    // startup) so they share a single channels.list request.
    let pending = this.channelIdPromises.get(channel.slug);
    if (!pending) {
      pending = this.fetchChannelId(channel).finally(() =>
        this.channelIdPromises.delete(channel.slug),
      );
      this.channelIdPromises.set(channel.slug, pending);
    }
    return pending;
  }

  private async fetchChannelId(channel: Channel): Promise<string> {
    const data = await this.apiGet('channels', {
      part: 'id',
      forHandle: channel.handle,
    });
    const id: string | undefined = data.items?.[0]?.id;
    if (!id) {
      throw new Error(`Channel not found for handle @${channel.handle}`);
    }
    this.channelIds.set(channel.slug, id);
    this.slugByChannelId.set(id, channel.slug);
    return id;
  }

  /**
   * Handle a WebSub push: fetch the referenced videos' live details and update
   * state. Costs 1 quota unit per (batched) lookup.
   */
  async handleNotification(
    channelId: string,
    videoIds: string[],
  ): Promise<void> {
    const slug = this.slugByChannelId.get(channelId);
    if (!slug) {
      this.logger.warn(`Notification for unknown channel ${channelId}`);
      return;
    }
    const items = await this.videoDetails(videoIds);
    for (const item of items) {
      this.track(slug, item);
    }
    this.recompute(slug);
  }

  private readState(channel: Channel): LivestreamInfo {
    return this.state.get(channel.slug) ?? this.defaultInfo(channel);
  }

  private defaultInfo(channel: Channel): LivestreamInfo {
    return {
      channel: channel.slug,
      channelName: channel.name,
      status: 'none',
      updatedAt: this.startedAt,
    };
  }

  /**
   * Discover videos from every channel's (free) RSS feed and classify them
   * with a cheap videos.list lookup. Runs on startup and on a timer to catch
   * newly scheduled streams that WebSub may not push.
   */
  private async discovery(): Promise<void> {
    if (this.discoveryRunning) {
      return;
    }
    this.discoveryRunning = true;
    try {
      await Promise.all(
        CHANNELS.map((channel) =>
          this.discoverChannel(channel).catch((err) => {
            this.logger.error(
              `Discovery failed for ${channel.slug}`,
              stackOf(err),
            );
            // Ensure the channel still has a deterministic state entry so the
            // API doesn't fall back to a fresh defaultInfo on every request.
            if (!this.state.has(channel.slug)) {
              this.state.set(channel.slug, this.defaultInfo(channel));
            }
          }),
        ),
      );
    } finally {
      this.discoveryRunning = false;
    }
  }

  private async discoverChannel(channel: Channel): Promise<void> {
    const channelId = await this.resolveChannelId(channel);
    const videoIds = await this.fetchFeedVideoIds(channelId);
    if (videoIds.length > 0) {
      const items = await this.videoDetails(videoIds);
      for (const item of items) {
        this.track(channel.slug, item);
      }
    }
    this.recompute(channel.slug);
  }

  /**
   * Adaptive transition poller: checks every tick while a stream is live or
   * imminent, and only every IDLE_TICKS-th tick otherwise, so idle channels
   * cost effectively no quota.
   */
  private async tick(): Promise<void> {
    // Evict streams whose past-window has elapsed, even when nothing is active.
    this.pruneExpired();
    this.tickCount = (this.tickCount + 1) % IDLE_TICKS;
    if (!this.hasActiveStream() && this.tickCount !== 0) {
      return;
    }
    if (this.reconcileRunning) {
      return;
    }
    this.reconcileRunning = true;
    try {
      await this.reconcile();
    } finally {
      this.reconcileRunning = false;
    }
  }

  /** Drop tracked "past" streams older than the window and recompute state. */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [slug, videos] of this.tracked) {
      let changed = false;
      for (const [videoId, v] of videos) {
        if (
          v.status === 'past' &&
          v.actualEndTime &&
          now - Date.parse(v.actualEndTime) > PAST_WINDOW_MS
        ) {
          videos.delete(videoId);
          changed = true;
        }
      }
      if (changed) {
        this.recompute(slug);
      }
    }
  }

  private hasActiveStream(): boolean {
    const now = Date.now();
    for (const videos of this.tracked.values()) {
      for (const v of videos.values()) {
        if (v.status === 'live') {
          return true;
        }
        if (
          v.status === 'upcoming' &&
          v.scheduledStartTime &&
          Date.parse(v.scheduledStartTime) - now <= SOON_WINDOW_MS
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** Re-check tracked upcoming/live videos to catch live/ended transitions. */
  private async reconcile(): Promise<void> {
    const active: string[] = [];
    const now = Date.now();
    for (const videos of this.tracked.values()) {
      for (const v of videos.values()) {
        if (v.status === 'live') {
          active.push(v.videoId);
        } else if (
          v.status === 'upcoming' &&
          v.scheduledStartTime &&
          Date.parse(v.scheduledStartTime) - now <= SOON_WINDOW_MS
        ) {
          active.push(v.videoId);
        }
      }
    }
    if (active.length === 0) {
      return;
    }
    try {
      const items = await this.videoDetails(active);
      const touched = new Set<string>();
      for (const item of items) {
        const slug = this.slugByChannelId.get(item.snippet?.channelId);
        if (slug) {
          this.track(slug, item);
          touched.add(slug);
        }
      }
      for (const slug of touched) {
        this.recompute(slug);
      }
    } catch (err) {
      this.logger.warn(`Reconcile failed: ${stackOf(err)}`);
    }
  }

  /** Record (or drop) a video's livestream state from a YouTube API item. */
  private track(slug: string, item: any): void {
    const videoId: string = item.id;
    const details = item.liveStreamingDetails;
    const videos = this.tracked.get(slug) ?? new Map<string, TrackedVideo>();
    this.tracked.set(slug, videos);

    // Not a livestream (regular upload) — ignore.
    if (!details) {
      videos.delete(videoId);
      return;
    }

    let status: LivestreamStatus;
    if (details.actualEndTime) {
      status = 'past';
    } else if (details.actualStartTime) {
      status = 'live';
    } else if (details.scheduledStartTime) {
      status = 'upcoming';
    } else {
      status = 'none';
    }

    // Drop streams that ended more than the past-window ago.
    if (
      status === 'past' &&
      Date.now() - Date.parse(details.actualEndTime) > PAST_WINDOW_MS
    ) {
      videos.delete(videoId);
      return;
    }
    if (status === 'none') {
      videos.delete(videoId);
      return;
    }

    videos.set(videoId, {
      videoId,
      title: item.snippet?.title ?? '',
      status,
      scheduledStartTime: details.scheduledStartTime,
      actualEndTime: details.actualEndTime,
      updatedAt: Date.now(),
    });
  }

  /** Recompute the derived channel status from its tracked videos. */
  private recompute(slug: string): void {
    const channel = this.channelsBySlug.get(slug);
    if (!channel) {
      return;
    }
    const base = {
      channel: channel.slug,
      channelName: channel.name,
      updatedAt: new Date().toISOString(),
    };
    const videos = [...(this.tracked.get(slug)?.values() ?? [])];
    const now = Date.now();

    const live = videos.find((v) => v.status === 'live');
    if (live) {
      this.state.set(slug, {
        ...base,
        status: 'live',
        title: live.title,
        url: watchUrl(live.videoId),
      });
      return;
    }

    const upcoming = videos
      .filter((v) => v.status === 'upcoming' && v.scheduledStartTime)
      .sort(
        (a, b) =>
          Date.parse(a.scheduledStartTime!) - Date.parse(b.scheduledStartTime!),
      )[0];
    if (upcoming) {
      this.state.set(slug, {
        ...base,
        status: 'upcoming',
        title: upcoming.title,
        url: watchUrl(upcoming.videoId),
        startTime: upcoming.scheduledStartTime,
      });
      return;
    }

    const past = videos
      .filter(
        (v) =>
          v.status === 'past' &&
          v.actualEndTime &&
          now - Date.parse(v.actualEndTime) <= PAST_WINDOW_MS,
      )
      .sort(
        (a, b) => Date.parse(b.actualEndTime!) - Date.parse(a.actualEndTime!),
      )[0];
    if (past) {
      this.state.set(slug, {
        ...base,
        status: 'past',
        title: past.title,
        url: watchUrl(past.videoId),
      });
      return;
    }

    this.state.set(slug, { ...base, status: 'none' });
  }

  /** Fetch recent video IDs from a channel's RSS feed (free, no quota). */
  private async fetchFeedVideoIds(channelId: string): Promise<string[]> {
    const res = await fetch(feedUrl(channelId), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Feed request failed: ${res.status}`);
    }
    const xml = await res.text();
    return [...xml.matchAll(videoIdPattern)].map((m) => m[1]);
  }

  private async videoDetails(videoIds: string[]): Promise<any[]> {
    const unique = [...new Set(videoIds)];
    if (unique.length === 0) {
      return [];
    }
    const items: any[] = [];
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
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `YouTube API ${path} request failed: ${res.status} ${res.statusText}` +
          (body ? ` - ${body}` : ''),
      );
    }
    return res.json();
  }
}
