import { DynamicModule, Module, ModuleMetadata } from '@nestjs/common';

import { HEALTH_CONFIG } from './health.constants';
import { HealthController } from './health.controller';
import { Version } from './version';

export interface HealthControllerConfigParams {
  version: Version;
  extraHealthData?: () => Promise<Record<string, any>>;
}

export interface HealthModuleAsyncParams
  extends Pick<ModuleMetadata, 'imports' | 'providers'> {
  useFactory: (
    ...args: any[]
  ) => HealthControllerConfigParams | Promise<HealthControllerConfigParams>;
  inject?: any[];
}

@Module({
  controllers: [HealthController],
})
export class HealthModule {
  static register(options: HealthControllerConfigParams): DynamicModule {
    return {
      module: HealthModule,
      providers: [{ provide: HEALTH_CONFIG, useValue: options }],
    };
  }

  static forRootAsync(options: HealthModuleAsyncParams): DynamicModule {
    return {
      module: HealthModule,
      imports: options.imports,
      providers: [
        {
          provide: HEALTH_CONFIG,
          useFactory: options.useFactory,
          inject: options.inject || [],
        },
      ],
    };
  }
}
