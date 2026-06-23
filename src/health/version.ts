import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Version {
  version: string;
  hash: string;
}

/**
 * Resolve the running build's version information.
 *
 * In a released container the CI writes a `version.json` (see
 * `.github/workflows/release.yml`) in the shape `{ "version": { hash, version } }`,
 * which is copied into the image and read here. For local/dev runs where that file
 * is absent, we fall back to the version from `package.json` and the `GIT_COMMIT`
 * environment variable (or `"dev"` when unset).
 */
export function getVersionInfo(cwd: string = process.cwd()): Version {
  const fromFile = readJsonField<Version>(join(cwd, 'version.json'), 'version');
  if (fromFile?.version && fromFile?.hash) {
    return { version: fromFile.version, hash: fromFile.hash };
  }

  const version = readJsonField<string>(join(cwd, 'package.json'), 'version') ?? 'unknown';
  return { version, hash: process.env.GIT_COMMIT ?? 'dev' };
}

function readJsonField<T>(path: string, field: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))[field] as T;
  } catch {
    return undefined;
  }
}
