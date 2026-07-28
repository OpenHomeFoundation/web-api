import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';

@Controller()
export class AppController {
  // Scaffolding left over from the project template: not part of the public API,
  // so it is kept out of the spec.
  @ApiExcludeEndpoint()
  @Get('test')
  getHello(): string {
    return 'Hello World';
  }
}
