import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { watchUrl, YouTubeClient, YouTubeItem } from '../youtube';
import { Channel, LIVESTREAM_CHANNELS } from './livestream.channels';
import { parseAtomFeed, stackOf } from './livestream.helpers';

export type LivestreamStatus = 'live' | 'upcoming' | 'past' | 'none';

export interface LivestreamInfo {
  /** Channel slug, e.g. "home-assistant". */
  channel: string;
  /** Human-friendly channel name. */
  channelName: string;
  status: LivestreamStatus;
  title?: string;
  url?: string;
  /**
   * ISO 8601 scheduled start time; present for "upcoming" streams and retained
   * for "live" ones that were scheduled ahead of time.
   */
  startTime?: string;
  /** ISO 8601 timestamp of when this channel's reported state last changed. */
  updatedAt: string;
}

/** A livestream video we are tracking the state of. */
interface TrackedVideo {
  videoId: string;
  title: string;
  status: LivestreamStatus;
  scheduledStartTime?: string;
  actualEndTime?: string;
}

const PAST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Re-scan channels' RSS feeds to discover newly scheduled/published videos. */
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Transition polling cadence. Every tick re-queries only the videos that are
 * live or imminent, so a tick with nothing active issues no requests at all and
 * idle channels cost no quota.
 */
const RECONCILE_TICK_MS = 10 * 1000;
/** Treat an upcoming stream as "imminent" within this window of its start. */
const SOON_WINDOW_MS = 15 * 60 * 1000;

@Injectable()
export class LivestreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LivestreamService.name);
  private readonly channelsBySlug: Map<string, Channel>;
  /** Derived, ready-to-serve status per channel slug. */
  private readonly state = new Map<string, LivestreamInfo>();
  /** Tracked livestream videos per channel slug. */
  private readonly tracked = new Map<string, Map<string, TrackedVideo>>();
  private readonly channelIds = new Map<string, string>();
  private readonly slugByChannelId = new Map<string, string>();
  /** In-flight channel-ID resolutions, to de-duplicate concurrent lookups. */
  private readonly channelIdPromises = new Map<string, Promise<string>>();
  /** Last seen feed fingerprint per slug, to skip redundant videos.list calls. */
  private readonly feedFingerprints = new Map<string, string>();
  /** Display name per slug, read from each channel's feed title. */
  private readonly channelNames = new Map<string, string>();
  /** Stable timestamp used for channels that have no state yet. */
  private readonly startedAt = new Date().toISOString();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private discoveryTimer?: ReturnType<typeof setInterval>;
  private discoveryRunning = false;
  private reconcileRunning = false;

  constructor(
    @Inject(LIVESTREAM_CHANNELS) private readonly channels: readonly Channel[],
    private readonly youtube: YouTubeClient,
  ) {
    this.channelsBySlug = new Map(this.channels.map((c) => [c.slug, c]));
  }

  onModuleInit(): void {
    // Seed initial state from each channel's (free) RSS feed so the API is not
    // blank until the first scheduled discovery sweep. Deliberately not awaited:
    // startup must not block on YouTube being reachable.
    void this.discovery();
    this.discoveryTimer = setInterval(
      () => void this.discovery(),
      DISCOVERY_INTERVAL_MS,
    );
    this.reconcileTimer = setInterval(
      () => void this.tick(),
      RECONCILE_TICK_MS,
    );
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
    return this.channels.map((channel) => this.readState(channel));
  }

  getStatus(slug: string): LivestreamInfo {
    const channel = this.channelsBySlug.get(slug);
    if (!channel) {
      // The requested slug is deliberately not echoed back. It is attacker
      // controlled, and a consumer that renders this message into a page would
      // inherit an injection we handed it. The path they asked for already tells
      // them which channel was not found.
      throw new NotFoundException('Unknown channel');
    }
    return this.readState(channel);
  }

  /** Resolve a channel's YouTube channel ID (UC…), caching the result. */
  private async resolveChannelId(channel: Channel): Promise<string> {
    const cached = this.channelIds.get(channel.slug);
    if (cached) {
      return cached;
    }
    // De-duplicate concurrent resolutions across a discovery sweep so they
    // share a single channels.list request.
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
    const id = await this.youtube.channelIdForHandle(channel.handle);
    this.channelIds.set(channel.slug, id);
    this.slugByChannelId.set(id, channel.slug);
    return id;
  }

  private readState(channel: Channel): LivestreamInfo {
    return this.state.get(channel.slug) ?? this.defaultInfo(channel);
  }

  private defaultInfo(channel: Channel): LivestreamInfo {
    return {
      channel: channel.slug,
      channelName: this.displayName(channel),
      status: 'none',
      updatedAt: this.startedAt,
    };
  }

  /**
   * The channel's display name: its YouTube feed title once known, falling back
   * to the slug so the field is always populated — including on the very first
   * request, before the initial discovery sweep has landed.
   */
  private displayName(channel: Channel): string {
    return this.channelNames.get(channel.slug) ?? channel.slug;
  }

  /**
   * Discover videos from every channel's (free) RSS feed and classify them
   * with a cheap videos.list lookup. Runs on startup and on a timer; this is
   * the only way newly scheduled or published streams enter our state.
   */
  private async discovery(): Promise<void> {
    if (this.discoveryRunning) {
      return;
    }
    this.discoveryRunning = true;
    try {
      await Promise.all(
        this.channels.map((channel) =>
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
    const { title, entries } = parseAtomFeed(
      await this.youtube.fetchChannelFeed(channelId),
    );

    // Display names come from the channel itself rather than config, so they
    // stay right through a rebrand without a deploy.
    if (title) {
      this.channelNames.set(channel.slug, title);
    }

    // The feed is free but videos.list is not, so only re-classify when the
    // feed actually changed. YouTube bumps an entry's <updated> when its
    // metadata changes, so this still catches retitled or rescheduled streams.
    const fingerprint = entries
      .map((entry) => `${entry.videoId}@${entry.updated}`)
      .join(',');
    if (fingerprint !== this.feedFingerprints.get(channel.slug)) {
      const videoIds = [...new Set(entries.map((entry) => entry.videoId))];
      if (videoIds.length > 0) {
        await this.refresh(new Map(videoIds.map((id) => [id, channel.slug])));
      }
      this.forgetUnlistedUpcoming(channel.slug, new Set(videoIds));
      // Recorded only after a successful sweep: a thrown lookup must not leave
      // us believing this feed is already classified.
      this.feedFingerprints.set(channel.slug, fingerprint);
    }

    this.recompute(channel.slug);
  }

  /**
   * Drop "upcoming" streams the channel feed no longer advertises. A scheduled
   * stream that is deleted or unscheduled simply disappears from the feed, so
   * videos.list is never asked about it again and refresh() cannot notice —
   * without this the API would advertise a stream that no longer exists
   * indefinitely.
   *
   * Deliberately limited to "upcoming". A live stream belongs to reconcile,
   * which re-queries the API and is authoritative about it, and a past one ages
   * out via pruneExpired; neither should be forgotten merely for falling out of
   * the feed's most-recent-entries window. Reached only after a successful feed
   * fetch, since a failure throws out of fetchFeed first.
   */
  private forgetUnlistedUpcoming(slug: string, listed: Set<string>): void {
    const videos = this.tracked.get(slug);
    if (!videos) {
      return;
    }
    for (const [videoId, v] of videos) {
      if (v.status === 'upcoming' && !listed.has(videoId)) {
        videos.delete(videoId);
        this.logger.log(`Untracked ${videoId}: no longer listed in the feed`);
      }
    }
  }

  /**
   * Classify a batch of video IDs (keyed to the channel that owns them) and
   * update their tracked state.
   *
   * videos.list silently omits IDs it will not serve — deleted, privated or
   * made members-only — so anything we asked about and did not get back is
   * gone and must be untracked. Skipping that leaves a stream pinned at its
   * last known status forever: a "live" one would keep its channel reporting
   * live and hold the fast reconcile cadence open indefinitely.
   *
   * Untracking is only safe because the caller reaches here on a successful
   * response; a failed request throws out of videoDetails instead, leaving
   * tracked state untouched rather than wrongly evicting live streams.
   *
   * Returns the slugs whose tracked videos changed.
   */
  private async refresh(
    slugByVideoId: Map<string, string>,
  ): Promise<Set<string>> {
    const touched = new Set<string>();
    const unreturned = new Map(slugByVideoId);
    const items = await this.youtube.videoDetails([...slugByVideoId.keys()]);

    for (const item of items) {
      unreturned.delete(item.id);
      // Prefer the caller's mapping; fall back to the channel the API reports
      // for IDs we did not ask about by channel.
      const channelId = item.snippet?.channelId;
      const slug =
        slugByVideoId.get(item.id) ??
        (channelId ? this.slugByChannelId.get(channelId) : undefined);
      if (slug) {
        this.track(slug, item);
        touched.add(slug);
      }
    }

    for (const [videoId, slug] of unreturned) {
      if (this.tracked.get(slug)?.delete(videoId)) {
        this.logger.log(
          `Untracked ${videoId}: no longer served by videos.list`,
        );
        touched.add(slug);
      }
    }

    return touched;
  }

  /**
   * Transition poller. Cheap when nothing is happening: reconcile() selects
   * only live or imminent videos, so an idle tick issues no requests and spends
   * no quota.
   */
  private async tick(): Promise<void> {
    // Evict streams whose past-window has elapsed, even when nothing is active.
    this.pruneExpired();
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

  /** Re-check tracked upcoming/live videos to catch live/ended transitions. */
  private async reconcile(): Promise<void> {
    const now = Date.now();
    const active = new Map<string, string>();
    for (const [slug, videos] of this.tracked) {
      for (const v of videos.values()) {
        if (
          v.status === 'live' ||
          (v.status === 'upcoming' &&
            v.scheduledStartTime &&
            Date.parse(v.scheduledStartTime) - now <= SOON_WINDOW_MS)
        ) {
          active.set(v.videoId, slug);
        }
      }
    }
    if (active.size === 0) {
      return;
    }
    try {
      for (const slug of await this.refresh(active)) {
        this.recompute(slug);
      }
    } catch (err) {
      this.logger.warn(`Reconcile failed: ${stackOf(err)}`);
    }
  }

  /** Record (or drop) a video's livestream state from a YouTube API item. */
  private track(slug: string, item: YouTubeItem): void {
    const videoId = item.id;
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

    // Drop streams that ended more than the past-window ago. An actualEndTime
    // is what made the status 'past', so testing it again only narrows the type.
    if (
      details.actualEndTime &&
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
    });
  }

  /**
   * Recompute the derived channel status from its tracked videos.
   *
   * updatedAt reports when the served state last *changed*, so clients can use
   * it for caching and change detection. Re-deriving identical state therefore
   * keeps the previous timestamp — otherwise it would advance on every 10s tick
   * for the whole duration of a live stream.
   */
  private recompute(slug: string): void {
    const channel = this.channelsBySlug.get(slug);
    if (!channel) {
      return;
    }

    const next = this.derive(channel);
    const previous = this.state.get(slug);
    const changed =
      !previous ||
      previous.status !== next.status ||
      previous.title !== next.title ||
      previous.url !== next.url ||
      previous.startTime !== next.startTime ||
      // A rebrand changes what we serve too, so it has to move the timestamp
      // or clients caching on updatedAt would keep the old name indefinitely.
      previous.channelName !== next.channelName;

    this.state.set(slug, {
      ...next,
      updatedAt: changed ? new Date().toISOString() : previous.updatedAt,
    });
  }

  /** Pick the channel's reportable stream: live first, else soonest upcoming, else latest recent past. */
  private derive(channel: Channel): Omit<LivestreamInfo, 'updatedAt'> {
    const base = {
      channel: channel.slug,
      channelName: this.displayName(channel),
    };
    const videos = [...(this.tracked.get(channel.slug)?.values() ?? [])];
    const now = Date.now();

    const live = videos.find((v) => v.status === 'live');
    if (live) {
      return {
        ...base,
        status: 'live',
        title: live.title,
        url: watchUrl(live.videoId),
        // Kept once the stream starts: a client watching the transition should
        // not see startTime appear and then vanish.
        startTime: live.scheduledStartTime,
      };
    }

    const upcoming = videos
      .filter((v) => v.status === 'upcoming' && v.scheduledStartTime)
      .sort(
        (a, b) =>
          Date.parse(a.scheduledStartTime!) - Date.parse(b.scheduledStartTime!),
      )[0];
    if (upcoming) {
      return {
        ...base,
        status: 'upcoming',
        title: upcoming.title,
        url: watchUrl(upcoming.videoId),
        startTime: upcoming.scheduledStartTime,
      };
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
      return {
        ...base,
        status: 'past',
        title: past.title,
        url: watchUrl(past.videoId),
      };
    }

    return { ...base, status: 'none' };
  }
}
