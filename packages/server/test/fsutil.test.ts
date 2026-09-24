import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentHash } from '@thoth/core'
import { commitText } from '@thoth/server'

const dir = () => mkdtempSync(join(tmpdir(), 'thoth-fs-'))

test('commitText: crea sin pisar, sustituye con el hash correcto y no deja temporales', async () => {
  const d = dir()
  const f = join(d, 'n.md')
  assert.deepEqual(await commitText(f, 'uno\n', null), { ok: true })
  assert.deepEqual(await commitText(f, 'otro\n', null), { ok: false, current: 'uno\n' }, 'crear no pisa')
  assert.deepEqual(await commitText(f, 'dos\n', contentHash('desfasado')), { ok: false, current: 'uno\n' })
  assert.equal(readFileSync(f, 'utf8'), 'uno\n', 'un hash desfasado no escribe')
  assert.deepEqual(await commitText(f, 'dos\n', contentHash('uno\n')), { ok: true })
  assert.equal(readFileSync(f, 'utf8'), 'dos\n')
  assert.deepEqual(readdirSync(d), ['n.md'], 'sin temporales ni enlaces .prev')
})

test('commitText: si el archivo no existe y se esperaba uno, no se crea', async () => {
  const d = dir()
  const f = join(d, 'n.md')
  assert.deepEqual(await commitText(f, 'x', contentHash('algo')), { ok: false, current: null })
  assert.deepEqual(readdirSync(d), [])
})

test('commitText: una escritura externa previa se detecta y se devuelve', async () => {
  const d = dir()
  const f = join(d, 'n.md')
  writeFileSync(f, 'v1\n')
  writeFileSync(f, 'v1 editada fuera\n') // alguien escribe después de que leyéramos v1
  const r = await commitText(f, 'mi versión\n', contentHash('v1\n'))
  assert.deepEqual(r, { ok: false, current: 'v1 editada fuera\n' })
  assert.equal(readFileSync(f, 'utf8'), 'v1 editada fuera\n')
})
