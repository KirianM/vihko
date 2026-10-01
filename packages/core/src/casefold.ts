// Full Unicode case folding (CaseFolding.txt, statuses C and F), for the
// case-insensitive comparisons: link keys, aliases, anchors and tags.
// `toLowerCase()` alone isn't folding: «Straße» and «STRASSE» differ, a final
// «ς» isn't «σ», «ﬁ» isn't «fi». Folding is locale-independent (no Turkic
// rules): «I» folds to «i», «ı» stays «ı», «İ» becomes «i̇».
//
// It starts from `toLowerCase()` (locale-independent in JavaScript) and fixes
// what differs from the folding: the table below, generated from Unicode 17's
// CaseFolding.txt against Node 26's `toLowerCase()` by
// `packages/core/scripts/casefold.ts`, plus Cherokee, whose lowercase letters
// fold to the uppercase ones. Nothing outside the BMP differs.
// No imports: the UI's main bundle takes it (query.ts).

/** Entries separated by a space: the first character folds to the rest. */
const PAIRS =
  'µμ ßss ŉʼn ſs ǰǰ ͅι ' +
  'ΐΐ ΰΰ ςσ ϐβ ϑθ ' +
  'ϕφ ϖπ ϰκ ϱρ ϵε ևեւ ' +
  'ᲀв ᲁд ᲂо ᲃс ᲄт ᲅт ᲆъ ' +
  'ᲇѣ ᲈꙋ ẖẖ ẗẗ ẘẘ ' +
  'ẙẙ ẚaʾ ẛṡ ẞss ὐὐ ' +
  'ὒὒ ὔὔ ὖὖ ᾀἀι ' +
  'ᾁἁι ᾂἂι ᾃἃι ᾄἄι ᾅἅι ' +
  'ᾆἆι ᾇἇι ᾈἀι ᾉἁι ᾊἂι ' +
  'ᾋἃι ᾌἄι ᾍἅι ᾎἆι ᾏἇι ' +
  'ᾐἠι ᾑἡι ᾒἢι ᾓἣι ᾔἤι ' +
  'ᾕἥι ᾖἦι ᾗἧι ᾘἠι ᾙἡι ' +
  'ᾚἢι ᾛἣι ᾜἤι ᾝἥι ᾞἦι ' +
  'ᾟἧι ᾠὠι ᾡὡι ᾢὢι ᾣὣι ' +
  'ᾤὤι ᾥὥι ᾦὦι ᾧὧι ᾨὠι ' +
  'ᾩὡι ᾪὢι ᾫὣι ᾬὤι ᾭὥι ' +
  'ᾮὦι ᾯὧι ᾲὰι ᾳαι ᾴάι ' +
  'ᾶᾶ ᾷᾶι ᾼαι ιι ῂὴι ' +
  'ῃηι ῄήι ῆῆ ῇῆι ' +
  'ῌηι ῒῒ ΐΐ ῖῖ ' +
  'ῗῗ ῢῢ ΰΰ ῤῤ ' +
  'ῦῦ ῧῧ ῲὼι ῳωι ' +
  'ῴώι ῶῶ ῷῶι ῼωι ' +
  'ﬀff ﬁfi ﬂfl ﬃffi ' +
  'ﬄffl ﬅst ﬆst ﬓմն ' +
  'ﬔմե ﬕմի ﬖվն ﬗմխ'

const TABLE = new Map<string, string>(PAIRS.split(' ').map((e) => [e[0]!, e.slice(1)]))
// What can be left to fix after `toLowerCase()`: the table's characters and lowercase Cherokee.
const SPECIAL = new RegExp(`[${[...TABLE.keys()].join('')}\\u13F8-\\u13FD\\uAB70-\\uABBF]`, 'g')

function cherokee(c: string): string {
  const n = c.charCodeAt(0)
  return String.fromCharCode(n >= 0xab70 ? n - 0xab70 + 0x13a0 : n - 8)
}

/** Full case folding, in NFC: two strings that differ only in case or normalization fold alike. */
export function caseFold(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(SPECIAL, (c) => TABLE.get(c) ?? cherokee(c)).normalize('NFC')
}
