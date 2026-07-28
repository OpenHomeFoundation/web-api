import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { LivestreamController } from './livestream.controller';
import { LivestreamInfo, LivestreamService } from './livestream.service';

const info = (overrides: Partial<LivestreamInfo> = {}): LivestreamInfo => ({
  channel: 'home-assistant',
  channelName: 'Home Assistant',
  status: 'none',
  updatedAt: '2026-07-27T12:00:00.000Z',
  ...overrides,
});

describe('LivestreamController', () => {
  let controller: LivestreamController;
  let service: { getAll: jest.Mock; getStatus: jest.Mock };

  beforeEach(async () => {
    service = { getAll: jest.fn(), getStatus: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LivestreamController],
      providers: [{ provide: LivestreamService, useValue: service }],
    }).compile();

    controller = module.get(LivestreamController);
  });

  describe('getAll', () => {
    it('returns the full list of channel statuses from the service', () => {
      const all = [
        info(),
        info({ channel: 'esphome', channelName: 'ESPHome', status: 'live' }),
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

    it('returns an empty list when the service has no channels to report', () => {
      service.getAll.mockReturnValue([]);

      expect(controller.getAll()).toEqual([]);
    });
  });

  describe('getStatus', () => {
    it('returns the status the service reports for the requested channel', () => {
      const status = info({
        status: 'live',
        title: 'Release Party',
        url: 'https://www.youtube.com/watch?v=abc123',
      });
      service.getStatus.mockReturnValue(status);

      expect(controller.getStatus('home-assistant')).toEqual(status);
    });

    it('forwards the slug to the service verbatim', () => {
      service.getStatus.mockReturnValue(info());

      controller.getStatus('open-home-foundation');

      expect(service.getStatus).toHaveBeenCalledTimes(1);
      expect(service.getStatus).toHaveBeenCalledWith('open-home-foundation');
    });

    it('does not sanitise or normalise the slug before delegating', () => {
      service.getStatus.mockReturnValue(info());

      // Slug validation belongs to the service, which owns the channel list.
      controller.getStatus('  Home-Assistant  ');

      expect(service.getStatus).toHaveBeenCalledWith('  Home-Assistant  ');
    });

    it('hands back the service object untouched, without copying or reshaping it', () => {
      const status = info({
        status: 'upcoming',
        startTime: '2026-08-01T17:00:00.000Z',
      });
      service.getStatus.mockReturnValue(status);

      const result = controller.getStatus('home-assistant');

      expect(result).toBe(status);
      expect(Object.keys(result)).toEqual(Object.keys(status));
    });

    it('propagates the NotFoundException raised for an unknown slug', () => {
      service.getStatus.mockImplementation(() => {
        throw new NotFoundException('Unknown channel "nope"');
      });

      expect(() => controller.getStatus('nope')).toThrow(NotFoundException);
      expect(() => controller.getStatus('nope')).toThrow(
        'Unknown channel "nope"',
      );
    });

    it('propagates non-HTTP service errors unchanged', () => {
      service.getStatus.mockImplementation(() => {
        throw new Error('boom');
      });

      expect(() => controller.getStatus('home-assistant')).toThrow('boom');
    });
  });
});
