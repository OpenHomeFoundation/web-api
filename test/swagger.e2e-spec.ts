import { Server } from 'node:http';

import request from 'supertest';

import { getVersionInfo } from '../src/health/version';
import { SWAGGER_JSON_PATH, SWAGGER_PATH } from '../src/main';
import { TestApp, startTestApp } from './test-app.fixture';

interface Schema {
  type?: string;
  format?: string;
  description?: string;
  enum?: string[];
  items?: Schema;
  $ref?: string;
  required?: string[];
  properties?: Record<string, Schema>;
}

interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    schema?: Schema;
  }[];
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: Schema }>;
    }
  >;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; description?: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

const RESPONSE_SCHEMA = 'LivestreamInfoResponse';
const CALENDAR_SCHEMA = 'CalendarInfoResponse';
const EVENT_SCHEMA = 'EventInfoResponse';

const okSchema = (operation: Operation): Schema | undefined =>
  operation.responses?.['200']?.content?.['application/json']?.schema;

describe('Swagger (e2e)', () => {
  let fixture: TestApp;
  let server: Server;
  let document: OpenApiDocument;

  beforeAll(async () => {
    fixture = await startTestApp();
    server = fixture.server;

    const res = await request(server).get(`/${SWAGGER_JSON_PATH}`);
    document = res.body;
  }, 30_000);

  afterAll(async () => {
    await fixture?.close();
  });

  describe(`GET /${SWAGGER_JSON_PATH}`, () => {
    it('serves an OpenAPI 3 document as JSON', async () => {
      const res = await request(server).get(`/${SWAGGER_JSON_PATH}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.openapi).toMatch(/^3\./);
    });

    it('describes the service, at the version of the running build', () => {
      expect(document.info.title).toBe('Open Home Foundation Web API');
      expect(document.info.description).toBeTruthy();
      expect(document.info.version).toBe(getVersionInfo().version);
    });
  });

  describe(`GET /${SWAGGER_PATH}`, () => {
    it('serves the Swagger UI', async () => {
      const res = await request(server).get(`/${SWAGGER_PATH}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('swagger-ui');
    });
  });

  describe('the documented livestream endpoints', () => {
    it('documents GET /livestream as an array of the response schema', () => {
      const operation = document.paths['/livestream']?.get;

      expect(operation).toBeDefined();
      expect(operation.tags).toContain('livestream');
      expect(operation.summary).toBeTruthy();
      expect(okSchema(operation)).toEqual({
        type: 'array',
        items: { $ref: `#/components/schemas/${RESPONSE_SCHEMA}` },
      });
    });

    it('documents GET /livestream/{slug} with its path parameter', () => {
      const operation = document.paths['/livestream/{slug}']?.get;

      expect(operation).toBeDefined();
      expect(operation.tags).toContain('livestream');
      expect(operation.summary).toBeTruthy();

      const slug = operation.parameters?.find((p) => p.name === 'slug');
      expect(slug).toMatchObject({ in: 'path', required: true });
      expect(slug?.schema?.type).toBe('string');
    });

    it('documents the single-channel 200 as the response schema', () => {
      const operation = document.paths['/livestream/{slug}'].get;

      expect(okSchema(operation)).toEqual({
        $ref: `#/components/schemas/${RESPONSE_SCHEMA}`,
      });
    });

    it('documents the 404 served for an unknown slug', () => {
      const responses = document.paths['/livestream/{slug}'].get.responses;

      expect(responses?.['404']).toBeDefined();
      expect(responses?.['404'].description).toBeTruthy();
    });
  });

  describe(`the ${RESPONSE_SCHEMA} schema`, () => {
    let schema: Schema;

    beforeAll(() => {
      const found = document.components?.schemas?.[RESPONSE_SCHEMA];
      if (!found) {
        throw new Error(`${RESPONSE_SCHEMA} is missing from the document`);
      }
      schema = found;
    });

    it('documents exactly the fields the endpoints serve', () => {
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
        [
          'channel',
          'channelName',
          'startTime',
          'status',
          'title',
          'updatedAt',
          'url',
        ].sort(),
      );
    });

    it('requires only the fields that are always served', () => {
      expect([...(schema.required ?? [])].sort()).toEqual([
        'channel',
        'channelName',
        'status',
        'updatedAt',
      ]);
    });

    it('documents status as the enum the service can report', () => {
      expect(schema.properties?.status.enum).toEqual([
        'live',
        'upcoming',
        'past',
        'none',
      ]);
    });

    it('describes every field', () => {
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        expect({ name, described: Boolean(property.description) }).toEqual({
          name,
          described: true,
        });
      }
    });
  });

  describe('the documented events endpoints', () => {
    it('documents GET /events as an array of the calendar schema', () => {
      const operation = document.paths['/events']?.get;

      expect(operation).toBeDefined();
      expect(operation.tags).toContain('events');
      expect(operation.summary).toBeTruthy();
      expect(okSchema(operation)).toEqual({
        type: 'array',
        items: { $ref: `#/components/schemas/${CALENDAR_SCHEMA}` },
      });
    });

    it('documents GET /events/{slug} with its path parameter', () => {
      const operation = document.paths['/events/{slug}']?.get;

      expect(operation).toBeDefined();
      expect(operation.tags).toContain('events');
      expect(operation.summary).toBeTruthy();

      const slug = operation.parameters?.find((p) => p.name === 'slug');
      expect(slug).toMatchObject({ in: 'path', required: true });
      expect(slug?.schema?.type).toBe('string');
    });

    it('documents the single-calendar 200 as the calendar schema', () => {
      const operation = document.paths['/events/{slug}'].get;

      expect(okSchema(operation)).toEqual({
        $ref: `#/components/schemas/${CALENDAR_SCHEMA}`,
      });
    });

    it('documents the 404 served for an unknown slug', () => {
      const responses = document.paths['/events/{slug}'].get.responses;

      expect(responses?.['404']).toBeDefined();
      expect(responses?.['404'].description).toBeTruthy();
    });
  });

  describe(`the ${CALENDAR_SCHEMA} and ${EVENT_SCHEMA} schemas`, () => {
    let calendar: Schema;
    let event: Schema;

    beforeAll(() => {
      const schemas = document.components?.schemas ?? {};
      const foundCalendar = schemas[CALENDAR_SCHEMA];
      const foundEvent = schemas[EVENT_SCHEMA];
      if (!foundCalendar || !foundEvent) {
        throw new Error(
          `${CALENDAR_SCHEMA} or ${EVENT_SCHEMA} is missing from the document`,
        );
      }
      calendar = foundCalendar;
      event = foundEvent;
    });

    it('documents exactly the calendar fields the endpoints serve', () => {
      expect(Object.keys(calendar.properties ?? {}).sort()).toEqual([
        'calendar',
        'calendarName',
        'events',
        'updatedAt',
      ]);
      expect([...(calendar.required ?? [])].sort()).toEqual([
        'calendar',
        'calendarName',
        'events',
        'updatedAt',
      ]);
      expect(calendar.properties?.events).toMatchObject({
        type: 'array',
        items: { $ref: `#/components/schemas/${EVENT_SCHEMA}` },
      });
    });

    it('documents exactly the event fields the endpoints serve', () => {
      expect(Object.keys(event.properties ?? {}).sort()).toEqual(
        [
          'id',
          'summary',
          'start',
          'end',
          'description',
          'location',
          'url',
          'latitude',
          'longitude',
          'status',
        ].sort(),
      );
    });

    it('requires only the event fields that are always served', () => {
      expect([...(event.required ?? [])].sort()).toEqual([
        'id',
        'start',
        'summary',
      ]);
    });

    it('documents status as the enum the service can report', () => {
      expect(event.properties?.status.enum).toEqual([
        'confirmed',
        'tentative',
        'cancelled',
      ]);
    });

    it('describes every field of both schemas', () => {
      for (const schema of [calendar, event]) {
        for (const [name, property] of Object.entries(
          schema.properties ?? {},
        )) {
          expect({ name, described: Boolean(property.description) }).toEqual({
            name,
            described: true,
          });
        }
      }
    });
  });

  describe('the documented health endpoints', () => {
    it.each(['/__lbheartbeat__', '/__heartbeat__', '/__version__'])(
      'documents GET %s',
      (path) => {
        const operation = document.paths[path]?.get;

        expect(operation).toBeDefined();
        expect(operation.tags).toContain('health');
        expect(operation.summary).toBeTruthy();
      },
    );

    it('documents the version payload as a schema', () => {
      const operation = document.paths['/__version__'].get;

      expect(okSchema(operation)).toEqual({
        $ref: '#/components/schemas/VersionResponse',
      });
      expect(
        Object.keys(
          document.components?.schemas?.VersionResponse.properties ?? {},
        ),
      ).toEqual(['version', 'hash']);
    });
  });

  it('documents every route the app serves, and nothing else', () => {
    // The spec is the API's contract, so a route appearing here that nobody
    // meant to publish — or a published one missing — should fail a test.
    expect(Object.keys(document.paths).sort()).toEqual([
      '/__heartbeat__',
      '/__lbheartbeat__',
      '/__version__',
      '/events',
      '/events/{slug}',
      '/livestream',
      '/livestream/{slug}',
    ]);
  });
});
