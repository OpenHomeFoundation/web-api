import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LivestreamService } from './livestream.service';

const channelIdPattern = /<yt:channelId>([^<]+)<\/yt:channelId>/;
const videoIdPattern = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
/** Cap videos processed per push to bound quota/CPU on oversized payloads. */
const MAX_VIDEO_IDS = 50;

const stackOf = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

/**
 * WebSub (PubSubHubbub) callback for YouTube push notifications.
 * https://developers.google.com/youtube/v3/guides/push_notifications
 */
@Controller('pubsub')
export class PubSubController {
  private readonly logger = new Logger(PubSubController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly livestream: LivestreamService,
  ) {}

  /** Hub subscription verification — echo back the challenge. */
  @Get()
  @Header('Content-Type', 'text/plain')
  verify(@Query() query: Record<string, string>): string {
    const mode = query['hub.mode'];
    const topic = query['hub.topic'];
    const challenge = query['hub.challenge'];

    if (!mode || !topic || !challenge) {
      throw new BadRequestException('Missing hub.mode, hub.topic, or hub.challenge');
    }

    const expectedToken = this.config.get<string>('PUBSUB_VERIFY_TOKEN');
    if (expectedToken && query['hub.verify_token'] !== expectedToken) {
      throw new ForbiddenException('Invalid hub.verify_token');
    }

    if (mode !== 'subscribe' && mode !== 'unsubscribe') {
      throw new BadRequestException(`Unsupported hub.mode "${mode}"`);
    }
    if (!topic.startsWith('https://www.youtube.com/feeds/videos.xml?channel_id=')) {
      throw new BadRequestException('Unsupported hub.topic');
    }

    this.logger.log(`Verified ${mode} for ${topic}`);
    return challenge;
  }

  /** Content-distribution notification with an Atom feed payload. */
  @Post()
  @HttpCode(204)
  notify(
    @Body() body: Buffer,
    @Headers('x-hub-signature') signature?: string,
  ): void {
    const secret = this.config.get<string>('PUBSUB_SECRET');
    // Fail closed: without a shared secret we can't authenticate the sender,
    // so refuse to do any (quota-costing) work for unauthenticated callers.
    if (!secret) {
      throw new ForbiddenException('PUBSUB_SECRET not configured');
    }
    if (!this.verifySignature(secret, signature, body)) {
      throw new ForbiddenException('Invalid signature');
    }

    const xml = Buffer.isBuffer(body) ? body.toString('utf8') : '';
    const channelId = channelIdPattern.exec(xml)?.[1];
    const videoIds = [...xml.matchAll(videoIdPattern)]
      .map((m) => m[1])
      .slice(0, MAX_VIDEO_IDS);
    if (!channelId || videoIds.length === 0) {
      return;
    }

    // Fire-and-forget: acknowledge the hub quickly.
    void this.livestream
      .handleNotification(channelId, videoIds)
      .catch((err) => this.logger.error('Failed to handle push', stackOf(err)));
  }

  private verifySignature(
    secret: string,
    signatureHeader: string | undefined,
    body: Buffer,
  ): boolean {
    // No raw bytes to verify (wrong/missing parser) — fail closed.
    if (!Buffer.isBuffer(body)) {
      return false;
    }
    const [algo, signature] = signatureHeader?.split('=') ?? [];
    if (algo !== 'sha1' || !signature) {
      return false;
    }
    try {
      const expected = createHmac('sha1', secret).update(body).digest();
      const provided = Buffer.from(signature, 'hex');
      return (
        provided.length === expected.length &&
        timingSafeEqual(provided, expected)
      );
    } catch {
      return false;
    }
  }
}
