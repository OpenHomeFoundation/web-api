import { Controller, Get, Inject } from '@nestjs/common';

import { HEALTH_CONFIG } from './health.constants';
import { HealthControllerConfigParams } from './health.module';
import { Version } from './version';

@Controller()
export class HealthController {
  constructor(
    @Inject(HEALTH_CONFIG) private config: HealthControllerConfigParams,
  ) {}

  @Get('__lbheartbeat__')
  lbheartbeat(): Record<string, any> {
    return {};
  }

  @Get('__heartbeat__')
  async heartbeat(): Promise<Record<string, any>> {
    if (this.config.extraHealthData) {
      return this.config.extraHealthData();
    }
    return {};
  }

  @Get('__version__')
  versionData(): Version {
    return this.config.version;
  }
}
