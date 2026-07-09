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
    const secret = this.config.get<string>('PUBSUB_SECRET');
    // Fail closed: without a shared secret we can't authenticate the sender,
    // so refuse to do any (quota-costing) work for unauthenticated callers.
    if (!secret) {
      throw new ForbiddenException('PUBSUB_SECRET not configured');
    }

    const rawBody = req.rawBody;
    if (!this.verifySignature(secret, req, rawBody)) {
      throw new ForbiddenException('Invalid signature');
    }

    const xml = rawBody?.toString('utf8') ?? '';
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
    req: RawBodyRequest<IncomingMessage>,
    rawBody: Buffer | undefined,
  ): boolean {
    // A secret is configured but we have no raw bytes to verify — fail closed.
    if (!rawBody) {
      return false;
    }
    const header = req.headers['x-hub-signature'];
    const value = Array.isArray(header) ? header[0] : header;
    const [algo, signature] = value?.split('=') ?? [];
    if (algo !== 'sha1' || !signature) {
      return false;
    }
    try {
      const expected = createHmac('sha1', secret).update(rawBody).digest();
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
