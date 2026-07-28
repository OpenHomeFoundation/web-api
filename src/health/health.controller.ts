import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HEALTH_CONFIG } from './health.constants';
import { HealthControllerConfigParams } from './health.module';
import { VersionResponse } from './version.response';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    @Inject(HEALTH_CONFIG) private config: HealthControllerConfigParams,
  ) {}

  @Get('__lbheartbeat__')
  @ApiOperation({
    summary: 'Liveness probe for the load balancer',
    description:
      'Answers as soon as the process can serve traffic, without touching any ' +
      'dependency. Always an empty JSON object.',
  })
  @ApiOkResponse({
    description: 'The process is up.',
    schema: { type: 'object', example: {} },
  })
  lbheartbeat(): Record<string, unknown> {
    return {};
  }

  @Get('__heartbeat__')
  @ApiOperation({
    summary: 'Health check, including any dependency detail the app reports',
    description:
      'Empty unless the app was registered with an extraHealthData callback, ' +
      'in which case the payload is whatever that callback returns.',
  })
  @ApiOkResponse({
    description: 'The app is healthy.',
    schema: { type: 'object', additionalProperties: true, example: {} },
  })
  async heartbeat(): Promise<Record<string, unknown>> {
    if (this.config.extraHealthData) {
      return this.config.extraHealthData();
    }
    return {};
  }

  @Get('__version__')
  @ApiOperation({ summary: 'Report the running build' })
  @ApiOkResponse({
    description: 'Version and commit of the running build.',
    type: VersionResponse,
  })
  versionData(): VersionResponse {
    return this.config.version;
  }
}
