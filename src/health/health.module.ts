import {
  DynamicModule,
  FactoryProvider,
  Module,
  ModuleMetadata,
} from '@nestjs/common';

import { HEALTH_CONFIG } from './health.constants';
import { HealthController } from './health.controller';
import { Version } from './version';

export interface HealthControllerConfigParams {
  version: Version;
  extraHealthData?: () => Promise<Record<string, unknown>>;
}

export interface HealthModuleAsyncParams extends Pick<
  ModuleMetadata,
  'imports' | 'providers'
> {
  // Borrowed from Nest's own provider types rather than restated: the factory
  // and its injected tokens are handed straight to a FactoryProvider below, so
  // anything Nest accepts there has to be accepted here.
  useFactory: FactoryProvider<
    HealthControllerConfigParams | Promise<HealthControllerConfigParams>
  >['useFactory'];
  inject?: FactoryProvider['inject'];
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
