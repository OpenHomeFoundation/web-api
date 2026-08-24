import { icsUrl, LumaClient } from './luma.client';

describe('icsUrl', () => {
  it("builds Luma's iCalendar export URL for a calendar", () => {
    expect(icsUrl('cal-6Tm2FkWzoBpLXWr')).toBe(
      'https://api.luma.com/ics/get?entity=calendar&id=cal-6Tm2FkWzoBpLXWr',
    );
  });

  it('URL-encodes the calendar ID', () => {
    // parseCalendars never lets one through, but the function should still be
    // safe on its own.
    expect(icsUrl('cal a&b')).toBe(
      'https://api.luma.com/ics/get?entity=calendar&id=cal%20a%26b',
    );
  });
});

describe('LumaClient', () => {
  let client: LumaClient;
  let fetchMock: jest.Mock;
  let originalFetch: typeof globalThis.fetch;

  const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';

  beforeEach(() => {
    client = new LumaClient();
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("fetches the calendar's feed by its export URL", async () => {
    fetchMock.mockResolvedValue(new Response(ICS, { status: 200 }));

    await expect(client.fetchCalendarFeed('cal-abc')).resolves.toBe(ICS);
    expect(String(fetchMock.mock.calls[0][0])).toBe(icsUrl('cal-abc'));
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(client.fetchCalendarFeed('cal-abc')).rejects.toThrow(
      'Feed request failed: 500',
    );
  });

  it('throws on a 200 that is not an iCalendar feed', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>captive portal</html>', { status: 200 }),
    );

    await expect(client.fetchCalendarFeed('cal-abc')).rejects.toThrow(
      'Feed response was not an iCalendar feed',
    );
  });

  it('bounds the request with a timeout signal', async () => {
    fetchMock.mockResolvedValue(new Response(ICS, { status: 200 }));

    await client.fetchCalendarFeed('cal-abc');

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
