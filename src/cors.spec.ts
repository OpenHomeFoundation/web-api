import {
  ANY_ORIGIN,
  CORS_ORIGINS_ENV,
  corsOriginMatchers,
  parseCorsOrigins,
} from './cors';

/** Does this configuration allow `origin`, the way enableCors() decides it? */
const allows = (raw: string, origin: string): boolean =>
  corsOriginMatchers(parseCorsOrigins(raw)).some((matcher) =>
    typeof matcher === 'string' ? matcher === origin : matcher.test(origin),
  );

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
  });

  describe('subdomain wildcards', () => {
    it('keeps a wildcard entry as written', () => {
      expect(parseCorsOrigins('https://*.esphome.io')).toEqual([
        'https://*.esphome.io',
      ]);
    });

    it('normalises a wildcard entry’s case', () => {
      expect(parseCorsOrigins('HTTPS://*.ESPHome.IO')).toEqual([
        'https://*.esphome.io',
      ]);
    });

    it.each([
      'https://www.esphome.io',
      'https://a.b.esphome.io',
      'https://WWW.ESPHOME.IO',
    ])('allows %s', (origin) => {
      expect(allows('https://*.esphome.io', origin)).toBe(true);
    });

    it.each([
      // The apex is not a subdomain of itself; list it separately to allow it.
      ['the bare domain', 'https://esphome.io'],
      ['a domain that merely ends the same way', 'https://evil-esphome.io'],
      ['the domain as a prefix of another', 'https://esphome.io.evil.example'],
      ['the same host over http', 'http://www.esphome.io'],
      ['a port that was not configured', 'https://www.esphome.io:8443'],
    ])('does not allow %s', (_case, origin) => {
      expect(allows('https://*.esphome.io', origin)).toBe(false);
    });

    it('allows the domain itself when it is listed alongside', () => {
      const raw = 'https://esphome.io,https://*.esphome.io';

      expect(allows(raw, 'https://esphome.io')).toBe(true);
      expect(allows(raw, 'https://www.esphome.io')).toBe(true);
    });

    it('leaves exact entries as plain strings', () => {
      expect(corsOriginMatchers(['https://esphome.io'])).toEqual([
        'https://esphome.io',
      ]);
    });

    it('rejects a wildcard that is not the leading label', () => {
      expect(() => parseCorsOrigins('https://sub.*.esphome.io')).toThrow(
        /only use "\*" as its leading label/,
      );
      expect(() => parseCorsOrigins('https://ev*l.esphome.io')).toThrow(
        /only use "\*" as its leading label/,
      );
    });

    it('rejects a wildcard over a whole suffix', () => {
      expect(() => parseCorsOrigins('https://*.io')).toThrow(
        /must name a domain below the wildcard/,
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
