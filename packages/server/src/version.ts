// vihko's version: the root package.json's, its one source (the workspace
// packages carry the same one, and a test keeps them equal). Read once when
// the server loads; in the Docker image the root package.json sits at /app,
// where this path resolves.
import { readFileSync } from 'node:fs'

function read(): string {
  const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  if (typeof version !== 'string' || !version) throw new Error('the root package.json has no version')
  return version
}

export const VERSION = read()
