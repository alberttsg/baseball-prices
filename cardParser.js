// Lee los datos de una carta de béisbol en un texto: el título de una venta (build.mjs) o el texto que el OCR
// lee en la foto de la carta (la app). Es el mismo archivo en los dos sitios para que las claves coincidan:
// si se cambia aquí, hay que copiarlo a la app (baseball/Components/Prices/cardParser.js).
// Salvo CODE_PATTERN y UPDATE_NUMBER_PATTERN, es el mismo que el de basketball-prices.
// No tiene dependencias: las listas de jugadores, sets, parallels y equipos llegan como datos (players.json y
// rules.json del feed), así que se pueden ampliar sin publicar una versión nueva de la app.

// Sin acentos, en minúsculas y sin apóstrofos ni puntos dentro de las palabras (O'Neal -> oneal, Jr. -> jr)
const stripAccents = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '')

export const normalizeText = (text) => ` ${stripAccents(String(text || '')).toLowerCase()
  .replace(/['’`]/g, '')
  .replace(/(\w)\.(?!\d)/g, '$1')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()} `

export const slugify = (name) => normalizeText(name).trim().replace(/ /g, '-')

const GRADERS = { psa: 'PSA', bgs: 'BGS', beckett: 'BGS', sgc: 'SGC', cgc: 'CGC', csg: 'CSG', tag: 'TAG', hga: 'HGA' }
// También "RCPSA 10": algunos títulos pegan RC al grado
const GRADE_PATTERN = /(?:^|[^a-z]|rc)(psa|bgs|beckett|sgc|cgc|csg|tag|hga)\s*(?:gem\s*(?:mint|mt)\s*)?(10|[1-9](?:\.5)?)(?![\d.])/
// Etiquetas de las cajas (la nota y la gradeadora no van juntas): "GEM MT 10", "MINT 9", "10 PSA"...
const LABEL_GRADE_PATTERN = /(?:gem\s*(?:mint|mt)|pristine|mint|nm[\s-]*mt|ex[\s-]*mt|vg[\s-]*ex)\s*(10|[1-9](?:\.5)?)(?![\d.])|(?:^|[^\d.])(10|[1-9](?:\.5)?)\s*(?:psa|bgs|sgc|cgc)(?![a-z])/
const GRADER_WORD_PATTERN = /(?:^|[^a-z])(psa|bgs|beckett|sgc|cgc|csg|tag|hga)(?![a-z])/
// Temporada (2020-21, 2025/26) o año suelto. Se usa el año de inicio
const SEASON_PATTERN = /(?:^|[^\d])(19[4-9]\d|20[0-4]\d)(?:\s*[-/]\s*(\d{2}))?(?!\d)/g
// #258, #GN-4, #BCV-18, #TC-CF... (no #/99, que es la tirada)
const NUMBER_PATTERN = /#\s*([a-z0-9]{1,6}(?:-[a-z0-9]{1,6})?)(?![a-z0-9])(?!\s*\/)/
// Sin "#": códigos con letras y guion (BCP-100, BDC-1, TC-15) y los números de Topps Update (US175, USC50)
const CODE_PATTERN = /(?:^|[^a-z0-9#\/])(?!(?:psa|bgs|sgc|cgc)-)([a-z]{1,5}-[a-z]{0,3}\d{1,4}[a-z]?)(?![a-z0-9])/
const UPDATE_NUMBER_PATTERN = /(?:^|[^a-z0-9])(usc?\d{1,3})(?![a-z0-9])/
// 87/125, #/199, /99 (después de quitar las temporadas)
const PRINT_RUN_PATTERN = /(?:^|[^\d])(?:\d{1,4})?\s*\/\s*(\d{1,5})(?!\d)/
const AUTO_PATTERN = / (auto|autos|autograph|autographed|signed|signature|signatures|rpa) /
const MEMORABILIA_PATTERN = / (patch|jersey|relic|swatch|memorabilia|game used|gu|rpa) /
const ROOKIE_PATTERN = / (rc|rookie|rookies) /

// Diccionarios a partir de players.json y rules.json. players: [[nombre, slug], ...]
export const createParser = ({ players, rules }) => {
  // Nombre normalizado -> slug. Los alias (Shaq, Wemby, Penny Hardaway...) vienen en rules.aliases
  const names = new Map()
  for (const [name, slug] of players) {
    const key = normalizeText(name).trim()
    if(!names.has(key)) names.set(key, slug)
  }
  // Sin sufijo (Jaren Jackson Jr. -> jaren jackson) si no es el nombre de otro jugador
  for (const [name, slug] of players) {
    const key = normalizeText(name).trim().replace(/ (jr|sr|ii|iii|iv)$/, '')
    if(!names.has(key)) names.set(key, slug)
  }
  for (const [alias, slug] of Object.entries(rules.aliases || {})) names.set(normalizeText(alias).trim(), slug)

  const playerNames = new Map(players.map(([name, slug]) => [slug, name]))

  // Sets: el alias más específico gana (prioridad del set y después el alias más largo)
  const setAliases = rules.sets
    .flatMap(set => [set.name, ...(set.aliases || [])].map(alias => ({ alias: normalizeText(alias), name: set.name, priority: set.priority ?? 2 })))
    .sort((a, b) => b.priority - a.priority || b.alias.length - a.alias.length)

  const parallelWords = [...rules.parallels].map(word => normalizeText(word)).sort((a, b) => b.length - a.length)
  const teamAliases = Object.entries(rules.teams).map(([alias, team]) => ({ alias: normalizeText(alias), team })).sort((a, b) => b.alias.length - a.alias.length)
  const excluded = rules.excluded.map(word => normalizeText(word))

  const findPlayer = (text) => {
    const words = text.trim().split(' ')
    for (let i = 0; i < words.length; i++) {
      // El nombre más largo que empiece en esta palabra (hasta 4 palabras)
      for (let size = Math.min(4, words.length - i); size >= 1; size--) {
        const slug = names.get(words.slice(i, i + size).join(' '))
        if(slug) return { slug, matched: ` ${words.slice(i, i + size).join(' ')} ` }
      }
    }
    return null
  }

  // grade: { grader, grade } que ya trae la venta (si lo trae). ocr: el texto viene de la foto de la carta, no
  // de un anuncio: no se descarta por las palabras excluidas (el reverso puede decir "photo", "lot"...)
  const parse = (title, grade, { ocr = false } = {}) => {
    const lower = stripAccents(String(title || '')).toLowerCase()
    let text = normalizeText(title)

    if(!ocr && excluded.some(word => text.includes(word))) return null

    const player = findPlayer(text)
    if(!player) return null
    text = text.replace(player.matched, ' ')

    // Grado: el de la venta o el que diga el título
    let grader = GRADERS[String(grade?.grader || '').toLowerCase()] || null
    let gradeValue = grader && grade?.grade ? String(grade.grade) : null
    if(!gradeValue){
      const match = lower.match(GRADE_PATTERN)
      if(match){
        grader = GRADERS[match[1]]
        gradeValue = match[2]
      }
    }
    if(!gradeValue){
      const graderWord = lower.match(GRADER_WORD_PATTERN)
      const label = graderWord && lower.match(LABEL_GRADE_PATTERN)
      if(label){
        grader = GRADERS[graderWord[1]]
        gradeValue = label[1] || label[2]
      }
    }

    const seasons = [...lower.matchAll(SEASON_PATTERN)]
    const year = seasons[0] ? Number(seasons[0][1]) : null
    const withoutSeasons = lower.replace(SEASON_PATTERN, ' ')

    const number = (withoutSeasons.match(NUMBER_PATTERN) || withoutSeasons.match(CODE_PATTERN) || withoutSeasons.match(UPDATE_NUMBER_PATTERN))?.[1]?.toUpperCase() || null
    const printRun = Number(withoutSeasons.replace(GRADE_PATTERN, ' ').match(PRINT_RUN_PATTERN)?.[1]) || null

    const set = setAliases.find(e => text.includes(e.alias))?.name || null

    let team = null
    for (const e of teamAliases) {
      if(!text.includes(e.alias)) continue
      team = team || e.team
      text = text.replace(e.alias, ' ')
    }

    // Parallel: las palabras de color y acabado en el orden del título (sin las del nombre del set)
    const setWords = new Set(normalizeText(set || '').trim().split(' '))
    const found = []
    let rest = text
    for (const word of parallelWords) {
      const index = rest.indexOf(word)
      if(index === -1 || setWords.has(word.trim())) continue
      found.push({ word: word.trim(), index })
      rest = rest.slice(0, index) + ' '.repeat(word.length) + rest.slice(index + word.length)
    }
    const parallel = found.sort((a, b) => a.index - b.index).map(e => e.word.replace(/\b\w/g, c => c.toUpperCase())).join(' ') || 'Base'

    return {
      player: player.slug,
      name: playerNames.get(player.slug) || null,
      team,
      year,
      set,
      number,
      parallel,
      printRun,
      auto: AUTO_PATTERN.test(text),
      memorabilia: MEMORABILIA_PATTERN.test(text),
      rookie: ROOKIE_PATTERN.test(text) || /rc(psa|bgs|sgc)/.test(lower),
      grade: grader && gradeValue ? `${grader} ${gradeValue}` : 'Raw',
    }
  }

  return { parse, findPlayer }
}

// Clave de la variante (sin el grado): las ventas con la misma clave se agrupan. El parallel va con las
// palabras ordenadas para que "Blue Ice" e "Ice Blue" sean la misma variante
export const variantKey = (card) => [
  card.year ?? '',
  card.set ? slugify(card.set) : '',
  card.number ?? '',
  card.parallel.toLowerCase().split(' ').sort().join('-'),
  card.printRun ?? '',
  card.auto ? 'auto' : '',
].join('|')
