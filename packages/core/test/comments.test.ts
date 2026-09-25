// Comparing a thread's commented text with the one it had (D-031.6). The
// parsing itself is tested with the editor (packages/web/test/comments.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorChanged, normalizeAnchor } from '@thoth/core'

test('whitespace and Unicode normalization are not changes', () => {
  assert.equal(normalizeAnchor('  We’ll\tuse\n Postgres  '), 'We’ll use Postgres')
  assert.equal(anchorChanged('Usaremos el índice.', 'Usaremos  el índice.'), false, 'a no-break space is whitespace')
  assert.equal(anchorChanged('índice', 'índice'), false, 'composed and decomposed accents')
})

test('any other difference is a change, however small', () => {
  assert.equal(anchorChanged('We will use Postgres.', 'We will not use Postgres.'), true)
  assert.equal(anchorChanged('Budget: 1000 €.', 'Budget: 100 €.'), true)
  assert.equal(anchorChanged('Case matters.', 'case matters.'), true)
  assert.equal(anchorChanged('Some text.', ''), true, 'the text is gone')
})

test('a thread that had no text to anchor to never changes', () => {
  assert.equal(anchorChanged('', 'Now there is text.'), false)
  assert.equal(anchorChanged('  ', ''), false)
})
