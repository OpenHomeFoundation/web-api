import { createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingMessage } from 'node:http';

import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Logger,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LivestreamService } from './livestream.service';

const channelIdPattern = /<yt:channelId>([^<]+)<\/yt:channelId>/;
const videoIdPattern = /<yt:videoId>([^<]+)<\/yt:videoId>/g;

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
    const challenge = query['hub.challenge'];
    if (!challenge) {
      throw new ForbiddenException('Missing hub.challenge');
    }
    this.logger.log(
      `Verified ${query['hub.mode']} for ${query['hub.topic']}`,
    );
    return challenge;
  }

  /** Content-distribution notification with an Atom feed payload. */
  @Post()
  @HttpCode(204)
  notify(@Req() req: RawBodyRequest<IncomingMessage>): void {
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!this.verifySignature(req, raw)) {
      throw new ForbiddenException('Invalid signature');
    }

    const channelId = channelIdPattern.exec(raw)?.[1];
    const videoIds = [...raw.matchAll(videoIdPattern)].map((m) => m[1]);
    if (!channelId || videoIds.length === 0) {
      return;
    }

    // Fire-and-forget: acknowledge the hub quickly.
    void this.livestream
      .handleNotification(channelId, videoIds)
      .catch((err) => this.logger.error(`Failed to handle push: ${err}`));
  }

  private verifySignature(
    req: RawBodyRequest<IncomingMessage>,
    raw: string,
  ): boolean {
    const secret = this.config.get<string>('PUBSUB_SECRET');
    if (!secret) {
      return true; // Verification disabled when no secret configured.
    }
    const header = req.headers['x-hub-signature'];
    const value = Array.isArray(header) ? header[0] : header;
    const [algo, signature] = value?.split('=') ?? [];
    if (!algo || !signature) {
      return false;
    }
    const expected = createHmac(algo, secret).update(raw).digest('hex');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
