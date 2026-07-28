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

  it('leaves the template scaffolding endpoint out of the spec', () => {
    // GET /test is excluded, but still routed.
    expect(document.paths['/test']).toBeUndefined();
  });
});
