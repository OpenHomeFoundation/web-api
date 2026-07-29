import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { IncomingMessage } from 'node:http';
import { ServerOptions } from 'socket.io';

import { ANY_ORIGIN, corsOriginMatchers, originMatches } from './cors';

/** What engine.io hands `allowRequest` to accept or refuse a handshake. */
type AllowRequestCallback = (
  message: string | null | undefined,
  allowed: boolean,
) => void;

/**
 * Socket.IO, restricted to the origins in CORS_ORIGINS — the same list the HTTP
 * endpoints honour.
 *
 * Setting socket.io's `cors` option alone would not do this. That option only
 * governs the polling transport, which is an ordinary cross-origin HTTP request;
 * a WebSocket upgrade is exempt from CORS entirely, so a browser on any site can
 * open one and read from it no matter what headers we would have sent. The
 * enforcement therefore lives in `allowRequest`, which engine.io calls on every
 * handshake, whichever transport it arrives on, and which answers a refusal with
 * a 403 before a connection exists. The `cors` option is still set so that a
 * rejected polling handshake fails the browser's own check too, and an accepted
 * one carries the headers the client expects.
 *
 * A handshake with no Origin header is allowed through: that is a non-browser
 * client, which CORS says nothing about, and refusing it here would be a stricter
 * rule than the HTTP endpoints apply to the same client. Note that this leaves
 * scripted clients able to open connections freely — CORS is not a rate limit.
 */
export class CorsIoAdapter extends IoAdapter {
  private readonly logger = new Logger(CorsIoAdapter.name);
  private readonly anyOrigin: boolean;
  private readonly matchers: readonly (string | RegExp)[];

  constructor(app: INestApplicationContext, origins: readonly string[]) {
    super(app);
    this.anyOrigin = origins[0] === ANY_ORIGIN;
    // Built once: the wildcard entries compile to regexes, and every handshake
    // is matched against them.
    this.matchers = this.anyOrigin ? [] : corsOriginMatchers([...origins]);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, {
      ...options,
      cors: {
        // An empty list allows nothing, which is the same default the HTTP side
        // takes when CORS_ORIGINS is unset.
        origin: this.anyOrigin ? ANY_ORIGIN : [...this.matchers],
        methods: ['GET'],
      },
      allowRequest: (req: IncomingMessage, allow: AllowRequestCallback) =>
        this.allowOrigin(req, allow),
    });
  }

  private allowOrigin(req: IncomingMessage, allow: AllowRequestCallback): void {
    const origin = req.headers.origin;

    if (origin === undefined) {
      allow(undefined, true);
      return;
    }

    if (this.anyOrigin || originMatches(this.matchers, origin)) {
      allow(undefined, true);
      return;
    }

    // Logged at debug: a page on an unlisted origin trying to connect is the
    // policy working, not an incident, and it is trivially repeatable by anyone.
    this.logger.debug(`Refused a socket handshake from ${origin}`);
    allow('Origin not allowed', false);
  }
}
