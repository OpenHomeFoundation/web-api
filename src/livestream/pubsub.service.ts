import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CHANNELS, feedUrl } from './livestream.channels';
import { LivestreamService } from './livestream.service';

const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';
/** Requested subscription lease (seconds). The hub caps this (~5–10 days). */
const LEASE_SECONDS = 432000;
/** Re-subscribe before the lease expires. */
const RENEW_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * Manages WebSub (PubSubHubbub) subscriptions to each channel's YouTube feed so
 * we receive push notifications instead of polling.
 */
@Injectable()
export class PubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PubSubService.name);
  private renewTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: ConfigService,
    private readonly livestream: LivestreamService,
  ) {}

  onModuleInit(): void {
    const baseUrl = this.config.get<string>('PUBLIC_BASE_URL');
    if (!baseUrl) {
      this.logger.warn(
        'PUBLIC_BASE_URL not set — skipping push subscriptions. ' +
          'Status will only update from the periodic reconcile.',
      );
      return;
    }
    void this.subscribeAll(baseUrl);
    this.renewTimer = setInterval(
      () => void this.subscribeAll(baseUrl),
      RENEW_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
    }
  }

  private async subscribeAll(baseUrl: string): Promise<void> {
    const callback = new URL('/pubsub', baseUrl).toString();
    const secret = this.config.get<string>('PUBSUB_SECRET');
    await Promise.all(
      CHANNELS.map(async (channel) => {
        try {
          const channelId = await this.livestream.resolveChannelId(channel);
          await this.subscribe(feedUrl(channelId), callback, secret);
          this.logger.log(`Subscribed to ${channel.slug}`);
        } catch (err) {
          this.logger.error(`Subscribe failed for ${channel.slug}: ${err}`);
        }
      }),
    );
  }

  private async subscribe(
    topic: string,
    callback: string,
    secret?: string,
  ): Promise<void> {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.topic': topic,
      'hub.callback': callback,
      'hub.verify': 'async',
      'hub.lease_seconds': String(LEASE_SECONDS),
    });
    if (secret) {
      params.set('hub.secret', secret);
    }
    const res = await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Hub responded ${res.status}`);
    }
  }
}
