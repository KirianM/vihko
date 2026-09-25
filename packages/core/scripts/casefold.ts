// Regenerates and checks the table of src/casefold.ts. Run it when Node moves
// to a new Unicode version (`process.versions.unicode`):
//   node packages/core/scripts/casefold.ts [path/to/CaseFolding.txt]
// Without a path it downloads the file for Node's Unicode version. It prints
// the PAIRS literal (differences between the folding and `toLowerCase()`,
// Cherokee aside) and checks every code point against the current caseFold.
import { readFileSync } from 'node:fs'
import { caseFold } from '../src/casefold.ts'

const version = process.versions.unicode ?? '17.0'
const text = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : await (await fetch(`https://www.unicode.org/Public/${version}.0/ucd/CaseFolding.txt`)).text()

const folding = new Map<number, string>()
for (const line of text.split('\n')) {
  const m = /^([0-9A-F]+); ([CF]); ([0-9A-F ]+);/.exec(line)
  if (m) folding.set(parseInt(m[1]!, 16), String.fromCodePoint(...m[3]!.split(' ').map((h) => parseInt(h, 16))))
}

const isCherokee = (cp: number) => (cp >= 0x13a0 && cp <= 0x13f5) || (cp >= 0x13f8 && cp <= 0x13fd) || (cp >= 0xab70 && cp <= 0xabbf)
const u = (n: number) => '\\u' + n.toString(16).toUpperCase().padStart(4, '0')
const entries: string[] = []
let wrong = 0
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue
  const ch = String.fromCodePoint(cp)
  const want = folding.get(cp) ?? ch
  if (want !== ch.toLowerCase() && !isCherokee(cp)) {
    if (cp > 0xffff) console.error(`outside the BMP: ${cp.toString(16)} (casefold.ts assumes none)`)
    entries.push(u(cp) + [...want].map((c) => u(c.codePointAt(0)!)).join(''))
  }
  // The check: folding the character in NFC, then NFC again.
  const nfc = ch.normalize('NFC')
  const expected = [...nfc].map((c) => folding.get(c.codePointAt(0)!) ?? c).join('').normalize('NFC')
  if (caseFold(ch) !== expected) {
    if (wrong++ < 20) console.error(`caseFold(U+${cp.toString(16)}) is wrong`)
  }
}

let out = ''
let row = ''
for (const e of entries) {
  if ((row + e).length > 94) { out += `  '${row}' +\n`; row = '' }
  row += e + ' '
}
console.log(`const PAIRS =\n${out}  '${row.trim()}'`)
console.error(wrong ? `${wrong} code points fold wrong: update PAIRS` : `every code point folds as Unicode ${version} says`)
process.exitCode = wrong ? 1 : 0
