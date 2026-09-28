// The environment variables that take numbers: a value that isn't one stops
// the start and names the variable, instead of running with NaN (a rescan
// every millisecond, a port the system picks). The values are the cases.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configFromEnv } from '@vihko/server'

test('numbers from the environment: defaults, good values, and a clear refusal for the rest', () => {
  const base = { VIHKO_NOTES_DIR: '/tmp/notes', VIHKO_STATE_DIR: '/tmp/state' }
  const d = configFromEnv(base)
  assert.equal(d.port, 8080)
  assert.equal(d.rescanSeconds, 60)
  const set = configFromEnv({ ...base, VIHKO_PORT: '8098', VIHKO_RESCAN_SECONDS: '300' })
  assert.equal(set.port, 8098)
  assert.equal(set.rescanSeconds, 300)
  assert.equal(configFromEnv({ ...base, VIHKO_PORT: '0' }).port, 0, 'the system picks one (tests)')
  for (const port of ['abc', '80.5', '-1', '65536', 'eighty']) {
    assert.throws(() => configFromEnv({ ...base, VIHKO_PORT: port }), new RegExp(`^Error: VIHKO_PORT: .*"${port}"`), port)
  }
  for (const s of ['abc', '0', '-5', 'NaN']) {
    assert.throws(() => configFromEnv({ ...base, VIHKO_RESCAN_SECONDS: s }), new RegExp(`^Error: VIHKO_RESCAN_SECONDS: .*"${s}"`), s)
  }
  assert.throws(() => configFromEnv({ ...base, VIHKO_HISTORY_QUIET_SECONDS: 'soon' }), /^Error: VIHKO_HISTORY_QUIET_SECONDS: /)
})
