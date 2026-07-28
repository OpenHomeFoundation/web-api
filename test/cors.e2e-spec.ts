import { Server } from 'node:http';

import request from 'supertest';

import { TestApp, startTestApp } from './test-app.fixture';

const ALLOWED = 'https://www.home-assistant.io';
const ALSO_ALLOWED = 'https://esphome.io';
const DENIED = 'https://not-configured.example';

describe('CORS from CORS_ORIGINS (e2e)', () => {
  describe('with a list of origins', () => {
    let fixture: TestApp;
    let server: Server;

    beforeAll(async () => {
      fixture = await startTestApp({
        corsOrigins: `${ALLOWED},${ALSO_ALLOWED}`,
      });
      server = fixture.server;
    }, 30_000);

    afterAll(async () => {
      await fixture?.close();
    });

    it.each([ALLOWED, ALSO_ALLOWED])(
      'lets a browser on %s read the response',
      async (origin) => {
        const res = await request(server)
          .get('/livestream')
          .set('Origin', origin);

        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe(origin);
      },
    );

    it('varies on Origin, so a cache cannot serve one site the headers meant for another', async () => {
      const res = await request(server)
        .get('/livestream')
        .set('Origin', ALLOWED);

      expect(res.headers['vary']).toMatch(/\bOrigin\b/);
    });

    it('withholds the header from an origin that is not configured', async () => {
      const res = await request(server)
        .get('/livestream')
        .set('Origin', DENIED);

      // The request still succeeds: CORS is the browser's rule, not the
      // server's. Without this header, the browser refuses to hand the body to
      // the page that asked for it.
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers a preflight for an allowed origin, advertising reads only', async () => {
      const res = await request(server)
        .options('/livestream')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'GET');

      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-methods']).toBe('GET');
    });

    it('matches an origin however the configured entry was written', async () => {
      // The configured value normalises to the header a browser sends, so a
      // trailing slash or different case in config still matches.
      const other = await startTestApp({ corsOrigins: 'HTTPS://ESPHome.IO/' });
      try {
        const res = await request(other.server)
          .get('/livestream')
          .set('Origin', ALSO_ALLOWED);

        expect(res.headers['access-control-allow-origin']).toBe(ALSO_ALLOWED);
      } finally {
        await other.close();
      }
    }, 30_000);
  });

  describe('with a domain and its subdomains', () => {
    let fixture: TestApp;

    beforeAll(async () => {
      fixture = await startTestApp({
        corsOrigins: 'https://home-assistant.io,https://*.home-assistant.io',
      });
    }, 30_000);

    afterAll(async () => {
      await fixture?.close();
    });

    it.each([
      'https://home-assistant.io',
      'https://www.home-assistant.io',
      'https://developers.home-assistant.io',
    ])('lets %s read the response', async (origin) => {
      const res = await request(fixture.server)
        .get('/livestream')
        .set('Origin', origin);

      expect(res.headers['access-control-allow-origin']).toBe(origin);
    });

    it.each([
      'https://evil-home-assistant.io',
      'https://home-assistant.io.evil.example',
      'http://www.home-assistant.io',
    ])('withholds the header from %s', async (origin) => {
      const res = await request(fixture.server)
        .get('/livestream')
        .set('Origin', origin);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
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

    it('lets any origin read the response', async () => {
      const res = await request(fixture.server)
        .get('/livestream')
        .set('Origin', DENIED);

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

    it('serves the API but grants no origin access to it', async () => {
      const res = await request(fixture.server)
        .get('/livestream')
        .set('Origin', ALLOWED);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
