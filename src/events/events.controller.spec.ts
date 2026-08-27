import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { EventsController } from './events.controller';
import { CalendarInfo, EventInfo, EventsService } from './events.service';

const event = (overrides: Partial<EventInfo> = {}): EventInfo => ({
  id: 'evt-abc@events.lu.ma',
  summary: 'Dublin - Hosted by the OHF',
  start: '2026-06-04T17:30:00.000Z',
  address: [],
  ...overrides,
});

const info = (overrides: Partial<CalendarInfo> = {}): CalendarInfo => ({
  calendar: 'home-assistant-meetups',
  calendarName: 'Home Assistant Meetups',
  events: [],
  updatedAt: '2026-08-18T12:00:00.000Z',
  ...overrides,
});

describe('EventsController', () => {
  let controller: EventsController;
  let service: { getAll: jest.Mock; getCalendar: jest.Mock };

  beforeEach(async () => {
    service = { getAll: jest.fn(), getCalendar: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [{ provide: EventsService, useValue: service }],
    }).compile();

    controller = module.get(EventsController);
  });

  describe('getAll', () => {
    it('returns the full list of calendars from the service', () => {
      const all = [
        info({ events: [event()] }),
        info({ calendar: 'esphome-events', calendarName: 'ESPHome Events' }),
      ];
      service.getAll.mockReturnValue(all);

      expect(controller.getAll()).toEqual(all);
    });

    it('asks the service exactly once and passes no arguments', () => {
      service.getAll.mockReturnValue([]);

      controller.getAll();

      expect(service.getAll).toHaveBeenCalledTimes(1);
      expect(service.getAll).toHaveBeenCalledWith();
    });

    it('hands back the service array untouched, without copying or reshaping it', () => {
      const all = [info()];
      service.getAll.mockReturnValue(all);

      const result = controller.getAll();

      expect(result).toBe(all);
      expect(result[0]).toBe(all[0]);
    });

    it('returns an empty list when the service has no calendars to report', () => {
      service.getAll.mockReturnValue([]);

      expect(controller.getAll()).toEqual([]);
    });
  });

  describe('getCalendar', () => {
    it('returns the calendar the service reports for the requested slug', () => {
      const calendar = info({ events: [event(), event({ id: 'evt-two' })] });
      service.getCalendar.mockReturnValue(calendar);

      expect(controller.getCalendar('home-assistant-meetups')).toEqual(
        calendar,
      );
    });

    it('forwards the slug to the service verbatim', () => {
      service.getCalendar.mockReturnValue(info());

      controller.getCalendar('esphome-events');

      expect(service.getCalendar).toHaveBeenCalledTimes(1);
      expect(service.getCalendar).toHaveBeenCalledWith('esphome-events');
    });

    it('does not sanitise or normalise the slug before delegating', () => {
      service.getCalendar.mockReturnValue(info());

      // Slug validation belongs to the service, which owns the calendar list.
      controller.getCalendar('  Home-Assistant-Meetups  ');

      expect(service.getCalendar).toHaveBeenCalledWith(
        '  Home-Assistant-Meetups  ',
      );
    });

    it('hands back the service object untouched, without copying or reshaping it', () => {
      const calendar = info({ events: [event()] });
      service.getCalendar.mockReturnValue(calendar);

      const result = controller.getCalendar('home-assistant-meetups');

      expect(result).toBe(calendar);
      expect(Object.keys(result)).toEqual(Object.keys(calendar));
    });

    it('propagates the NotFoundException raised for an unknown slug', () => {
      service.getCalendar.mockImplementation(() => {
        throw new NotFoundException('Unknown calendar');
      });

      expect(() => controller.getCalendar('nope')).toThrow(NotFoundException);
      expect(() => controller.getCalendar('nope')).toThrow('Unknown calendar');
    });

    it('propagates non-HTTP service errors unchanged', () => {
      service.getCalendar.mockImplementation(() => {
        throw new Error('boom');
      });

      expect(() => controller.getCalendar('home-assistant-meetups')).toThrow(
        'boom',
      );
    });
  });
});
