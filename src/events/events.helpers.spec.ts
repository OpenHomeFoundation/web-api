import { eventsEqual } from './events.helpers';
import type { EventInfo } from './events.service';

/**
 * eventsEqual is unit-tested rather than driven through the service because
 * `address` is derived from `description`: any feed that changes an address
 * also changes the description, so a service-level test trips the description
 * comparison first and would pass even with the array comparison broken.
 */
const event = (overrides: Partial<EventInfo> = {}): EventInfo => ({
  id: 'evt-dublin@events.lu.ma',
  summary: 'Dublin - Hosted by the OHF',
  start: '2026-06-04T17:30:00.000Z',
  address: ['26 Wexford St', 'Dublin', 'Ireland'],
  ...overrides,
});

describe('eventsEqual', () => {
  it('treats two freshly parsed copies of the same event as equal', () => {
    // Every refresh re-parses the feed into new arrays; identity would fail.
    expect(eventsEqual([event()], [event()])).toBe(true);
  });

  it('reports a changed address line as a change', () => {
    expect(
      eventsEqual(
        [event()],
        [event({ address: ['27 Wexford St', 'Dublin', 'Ireland'] })],
      ),
    ).toBe(false);
  });

  it('reports a reordered address as a change', () => {
    expect(
      eventsEqual(
        [event()],
        [event({ address: ['Dublin', '26 Wexford St', 'Ireland'] })],
      ),
    ).toBe(false);
  });

  it('reports an address that gained a line as a change', () => {
    expect(
      eventsEqual(
        [event()],
        [event({ address: ['26 Wexford St', 'Dublin', 'Ireland', 'Earth'] })],
      ),
    ).toBe(false);
  });

  it('reports an emptied address as a change', () => {
    expect(eventsEqual([event()], [event({ address: [] })])).toBe(false);
  });

  it('still compares the scalar fields', () => {
    expect(eventsEqual([event()], [event({ summary: 'Galway' })])).toBe(false);
    expect(eventsEqual([event()], [event({ status: 'confirmed' })])).toBe(
      false,
    );
  });

  it('reports a differing list length as a change', () => {
    expect(eventsEqual([event()], [event(), event({ id: 'evt-galway' })])).toBe(
      false,
    );
  });
});
