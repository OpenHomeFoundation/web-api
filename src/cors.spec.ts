import { ANY_ORIGIN, CORS_ORIGINS_ENV, parseCorsOrigins } from './cors';

describe('parseCorsOrigins', () => {
  describe('no configured origins', () => {
    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['blank', '   '],
      ['commas only', ' , ,, '],
    ])('reports no origins when the variable is %s', (_case, raw) => {
      expect(parseCorsOrigins(raw)).toEqual([]);
    });
  });

  describe('a list of origins', () => {
    it('keeps the configured origins, in order', () => {
      expect(
        parseCorsOrigins('https://www.home-assistant.io,https://esphome.io'),
      ).toEqual(['https://www.home-assistant.io', 'https://esphome.io']);
    });

    it('ignores whitespace and a trailing comma', () => {
      expect(
        parseCorsOrigins(' https://esphome.io , https://music-assistant.io , '),
      ).toEqual(['https://esphome.io', 'https://music-assistant.io']);
    });

    it('keeps a non-default port, which is part of the origin', () => {
      expect(parseCorsOrigins('http://localhost:8123')).toEqual([
        'http://localhost:8123',
      ]);
    });

    it('drops a default port, which browsers do not send', () => {
      expect(parseCorsOrigins('https://esphome.io:443')).toEqual([
        'https://esphome.io',
      ]);
    });

    it('normalises case, so an entry matches the header a browser sends', () => {
      expect(parseCorsOrigins('HTTPS://ESPHome.IO')).toEqual([
        'https://esphome.io',
      ]);
    });

    it('accepts a trailing slash and normalises it away', () => {
      expect(parseCorsOrigins('https://esphome.io/')).toEqual([
        'https://esphome.io',
      ]);
    });

    it('allows plain http, for local development', () => {
      expect(parseCorsOrigins('http://localhost:3000')).toEqual([
        'http://localhost:3000',
      ]);
    });
  });

  describe(`"${ANY_ORIGIN}"`, () => {
    it('allows any origin', () => {
      expect(parseCorsOrigins(ANY_ORIGIN)).toEqual([ANY_ORIGIN]);
    });

    it('rejects mixing it with specific origins', () => {
      expect(() => parseCorsOrigins('*,https://esphome.io')).toThrow(
        /mixes "\*" with specific origins/,
      );
    });

    it('rejects it as a wildcard inside an origin', () => {
      expect(() => parseCorsOrigins('https://*.esphome.io')).toThrow(
        /cannot contain a wildcard/,
      );
    });
  });

  describe('malformed configuration', () => {
    it('rejects an entry that is not a URL', () => {
      expect(() => parseCorsOrigins('esphome.io')).toThrow(/is not a URL/);
    });

    it('rejects a scheme that is not http or https', () => {
      expect(() => parseCorsOrigins('ftp://esphome.io')).toThrow(
        /must use http or https/,
      );
    });

    it('rejects an origin carrying a path', () => {
      expect(() => parseCorsOrigins('https://esphome.io/docs')).toThrow(
        /scheme and host only/,
      );
    });

    it('rejects an origin carrying a query or fragment', () => {
      expect(() => parseCorsOrigins('https://esphome.io?a=1')).toThrow(
        /scheme and host only/,
      );
      expect(() => parseCorsOrigins('https://esphome.io#top')).toThrow(
        /scheme and host only/,
      );
    });

    it('rejects credentials in an origin', () => {
      expect(() => parseCorsOrigins('https://user:pw@esphome.io')).toThrow(
        /must not carry credentials/,
      );
    });

    it('rejects the same origin listed twice, however it is written', () => {
      expect(() =>
        parseCorsOrigins('https://esphome.io,https://ESPHome.io/'),
      ).toThrow(/lists "https:\/\/esphome.io" twice/);
    });

    it('names the variable and the offending entry', () => {
      expect(() => parseCorsOrigins('https://esphome.io,nope')).toThrow(
        `${CORS_ORIGINS_ENV}[1] "nope"`,
      );
    });
  });
});
