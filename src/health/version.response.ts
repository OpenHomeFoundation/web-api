import { ApiProperty } from '@nestjs/swagger';

import { Version } from './version';

/**
 * The documented shape of `GET /__version__`. `Version` is an interface, which
 * leaves no runtime metadata for `@nestjs/swagger`, so the schema lives here.
 */
export class VersionResponse implements Version {
  @ApiProperty({
    description: "The running build's version.",
    example: '0.1.0',
  })
  version!: string;

  @ApiProperty({
    description:
      'Git commit the build was made from, or "dev" for a local run.',
    example: '9f1c0d2a1b3c4d5e6f708192a3b4c5d6e7f80912',
  })
  hash!: string;
}
