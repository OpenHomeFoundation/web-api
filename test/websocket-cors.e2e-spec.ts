import { Server } from 'node:http';

import { io } from 'socket.io-client';
import request from 'supertest';

import { TestApp, startTestApp } from './test-app.fixture';

const ALLOWED = 'https://www.home-assistant.io';
const DENIED = 'https://not-configured.example';

/** The polling handshake, which is the transport a browser tries first. */
const handshake = (server: Server, origin?: string) => {
  const req = request(server).get('/socket.io/').query({
    EIO: '4',
    transport: 'polling',
  });
  return origin === undefined ? req : req.set('Origin', origin);
};

/**
 * Connect a real client and resolve how it went. Used for the WebSocket
 * transport, which no amount of header assertions can stand in for: a WebSocket
 * upgrade is not subject to CORS, so the only question that matters is whether
 * the server refused it.
 */
const connect = (url: string, origin: string, transport: string) =>
  new Promise<'connected' | 'refused'>((resolve, reject) => {
    const socket = io(url, {
      transports: [transport],
      extraHeaders: { Origin: origin },
      reconnection: false,
      timeout: 4_000,
    });
    // Cleared on both paths: a timer still pending is a handle Jest waits on,
    // and it reports the suite as leaking.
    const giveUp = setTimeout(() => {
      socket.close();
      reject(new Error(`neither connected nor refused over ${transport}`));
    }, 5_000);
    const finish = (outcome: 'connected' | 'refused') => {
      clearTimeout(giveUp);
      socket.close();
      resolve(outcome);
    };
    socket.on('connect', () => finish('connected'));
    socket.on('connect_error', () => finish('refused'));
  });

describe('WebSocket origins (e2e)', () => {
  describe('with a list of origins', () => {
    let fixture: TestApp;

    beforeAll(async () => {
      fixture = await startTestApp({ corsOrigins: ALLOWED, listen: true });
    }, 30_000);

    afterAll(async () => {
      await fixture?.close();
    });

    it('accepts a polling handshake from a configured origin, and says so', async () => {
      const res = await handshake(fixture.server, ALLOWED);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    });

    it('refuses a polling handshake from an origin that is not configured', async () => {
      const res = await handshake(fixture.server, DENIED);

      // Refused outright rather than merely left without CORS headers: a socket
      // that exists is a socket that consumes memory, whoever may read from it.
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it.each(['websocket', 'polling'])(
      'refuses a %s connection from an origin that is not configured',
      async (transport) => {
        await expect(connect(fixture.url!, DENIED, transport)).resolves.toBe(
          'refused',
        );
      },
      20_000,
    );

    it.each(['websocket', 'polling'])(
      'accepts a %s connection from a configured origin',
      async (transport) => {
        await expect(connect(fixture.url!, ALLOWED, transport)).resolves.toBe(
          'connected',
        );
      },
      20_000,
    );

    it('lets a client that sends no Origin through, as the HTTP endpoints do', async () => {
      // Not a browser, so CORS has nothing to say about it. Refusing here would
      // hold sockets to a stricter rule than /livestream applies to the same
      // client.
      const res = await handshake(fixture.server);

      expect(res.status).toBe(200);
    });
  });

  describe('with a domain and its subdomains', () => {
    let fixture: TestApp;

    beforeAll(async () => {
      fixture = await startTestApp({
        corsOrigins: 'https://*.home-assistant.io',
      });
    }, 30_000);

    afterAll(async () => {
      await fixture?.close();
    });

    it('applies the same wildcard rules as the HTTP endpoints', async () => {
      const allowed = await handshake(
        fixture.server,
        'https://www.home-assistant.io',
      );
      const lookalike = await handshake(
        fixture.server,
        'https://evil-home-assistant.io',
      );

      expect(allowed.status).toBe(200);
      expect(lookalike.status).toBe(403);
    });
  });

  describe('with "*"', () => {
    let fixture: TestApp;

    beforeAll(async () => {
      fixture = await startTestApp({ corsOrigins: '*' });
    }, 30_000);

    afterAll(async () => {
      await fixture?.close();
    });

    it('accepts any origin, as configured', async () => {
      const res = await handshake(fixture.server, DENIED);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('with nothing configured', () => {
    let fixture: TestApp;

    beforeAll(async () => {
      fixture = await startTestApp();
    }, 30_000);

    afterAll(async () => {
      await fixture?.close();
    });

    it('refuses every origin, matching the HTTP default of granting none', async () => {
      const res = await handshake(fixture.server, ALLOWED);

      expect(res.status).toBe(403);
    });
  });
});
