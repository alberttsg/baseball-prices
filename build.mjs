// Precios de cartas de béisbol a partir de las ventas de TheCardAPI, publicados como JSON estáticos en GitHub
// Pages para la app. Se ejecuta cada día (.github/workflows/update-prices.yml):
//   THECARDAPI_KEY=... node build.mjs <carpeta de salida>
// La carpeta de salida tiene lo ya publicado: el histórico de cada carta se completa con los días nuevos.
// Para saber cuántas filas del plan gasta un día (sin procesar nada; gasta una fila por búsqueda):
//   THECARDAPI_KEY=... node build.mjs --estimate [YYYY-MM-DD]
//
// Es el mismo proceso que basketball-prices. Diferencias: se descartan las ventas que la API marca como de
// otro deporte y, antes de procesar un día, se cuentan sus filas y se elige el precio mínimo más bajo con el
// que cabe en lo que queda del plan (PRICE_FLOORS), para no empezarlo si no cabe.
//
// Las ventas se buscan por nombre de jugador (data/players.json) y sus títulos se leen con cardParser.js, el
// mismo archivo que usa la app para leer el texto de la foto, así que las claves coinciden.
// No se publican las ventas sueltas, solo el resumen de cada día por carta (mediana, nº de ventas, mín. y máx.).
// Las ventas en bruto se guardan en raw/ (caché de Actions, privada) para volver a leer los días cuando cambia
// el parser. En el log sale por qué se descartan las ventas no reconocidas, con ejemplos.
//
// Archivos publicados:
//   index.json         { updated, epoch, days: { 'YYYY-MM-DD': 'final' | 'partial' }, players: { slug: nº de cartas },
//                      teams: { slug: equipo } }
//   players.json       [[nombre, slug, activo], ...] (todos los jugadores, para reconocer el nombre en la app)
//   rules.json         sets, parallels, equipos, alias y palabras excluidas (para cardParser.js en la app)
//   trends.json        { updated, epoch, lists: { rising7, falling7, rising30, falling30, top } }, cada una
//                      [{ slug, name, team, key, grade, year, set, number, parallel, printRun, auto, rookie,
//                      image, price, from, change }] (precios en céntimos, change en %)
//   p/<slug>.json      { name, slug, team, epoch, cards: [{ year, set, number, parallel, printRun, auto,
//                        memorabilia, rookie, image, grades: { 'Raw' | 'PSA 10' | ...: { price, low, high, sales,
//                        lastSale, history: [[día, mediana, ventas, mín, máx], ...] } } }] }
// Precios en céntimos de USD. El día es el nº de días desde epoch. price/low/high/sales son de los últimos
// SUMMARY_DAYS días; si la carta no se ha vendido en ese tiempo, price es la mediana de su última venta.

import { readFile, writeFile, readdir, mkdir, rm, appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createParser, variantKey, normalizeText } from './cardParser.js'

const API_URL = 'https://www.thecardapi.com/api/v1/market/sales'
const API_KEY = process.env.THECARDAPI_KEY
// Días hacia atrás que permite consultar el plan (gratis: 3, Starter: 14)
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 3)
const FORCE = !!process.env.FORCE

const EPOCH = '2026-01-01'
const HISTORY_DAYS = 180
const SUMMARY_DAYS = 30
// Nombres por búsqueda: la API acepta "(nombre, nombre, ...)" como O. Con 700 aún responde, se deja margen
const NAMES_PER_QUERY = 600
const PAGE_LIMIT = 1000
// Precio mínimo (USD) de las ventas que se piden: se elige cada día el más bajo con el que el día cabe en lo que
// queda del plan (primero todas las ventas; si no caben, de 1 USD o más; si tampoco, de 2...). Así se aprovechan
// todas las filas del plan y entran las cartas baratas siempre que se pueda. MIN_PRICE (variable del repositorio,
// opcional) es el mínimo desde el que se empieza a probar
const MIN_PRICE = Number(process.env.MIN_PRICE) || 0
const PRICE_FLOORS = [0, 1, 2, 3, 5, 8, 12, 20, 40].filter(floor => floor >= MIN_PRICE)
// Precio mínimo de los días procesados antes de guardarlo en index.json (MIN_PRICE fijo de entonces)
const LEGACY_MIN_PRICE = 8
const SPORT = 'Baseball'
// Ventas en bruto de cada día (solo lo que lee el parser), en la caché de Actions (privada, no se publica):
// cuando cambian cardParser.js o las listas, los días guardados se vuelven a leer sin gastar filas del plan
const RAW_DIR = 'raw'
const RAW_DAYS = 60

const DAY_MS = 24 * 3600 * 1000
const toDayNumber = (date) => Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${EPOCH}T00:00:00Z`)) / DAY_MS)
const toDate = (dayNumber) => new Date(new Date(`${EPOCH}T00:00:00Z`).getTime() + dayNumber * DAY_MS).toISOString().slice(0, 10)
const todayNumber = () => toDayNumber(new Date().toISOString().slice(0, 10))
const cents = (value) => Math.round(value * 100)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (e) {
    return null
  }
}

// Filas que quedan hoy en el plan y filas por día del plan (de la última respuesta)
let rowsRemaining = Infinity
let rowsLimit = Infinity

class BudgetError extends Error {}

const request = async (params) => {
  const url = `${API_URL}?${new URLSearchParams(params)}`

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'x-market-api-key': API_KEY } })
    const remaining = res.headers.get('x-ratelimit-remaining')
    const limit = res.headers.get('x-ratelimit-limit')
    if(limit !== null) rowsLimit = Number(limit)

    if(res.ok){
      const body = await res.json()
      // El contador de la API va con retraso (descuenta las filas un rato después): se lleva también la cuenta
      // propia (una fila por venta devuelta, mínimo una por búsqueda) y vale la más baja
      const charged = Math.max(1, body.data?.length || 0)
      rowsRemaining = Math.min(rowsRemaining - charged, remaining !== null ? Number(remaining) : Infinity)
      return body
    }
    if(remaining !== null) rowsRemaining = Number(remaining)
    if(res.status === 429 && rowsRemaining === 0) throw new BudgetError('Sin filas disponibles hoy')
    if(attempt >= 4 || (res.status < 500 && res.status !== 429)) throw new Error(`${res.status} ${await res.text()}`)
    await sleep(2000 * attempt)
  }
}

const queryParams = (query, date, minPrice) => ({
  q: query,
  category: 'sports',
  date_from: date,
  date_to: date,
  ...(minPrice ? { price_min: minPrice } : {}),
})

// Filas que tiene un día con ese precio mínimo (una fila del plan por búsqueda)
const countDay = async (date, queries, minPrice) => {
  let total = 0
  for (const query of queries) {
    const page = await request({ ...queryParams(query, date, minPrice), limit: 1 })
    total += page.pagination?.total || 0
    await sleep(250)
  }
  return total
}

// Todas las ventas de un día de los jugadores de la lista, desde ese precio mínimo
const fetchDay = async (date, queries, minPrice) => {
  const sales = new Map()

  for (const query of queries) {
    let cursor = null
    do {
      const params = { ...queryParams(query, date, minPrice), limit: PAGE_LIMIT }
      if(cursor) params.cursor = cursor
      const page = await request(params)
      for (const sale of page.data || []) sales.set(sale.id, sale)
      cursor = page.data?.length === PAGE_LIMIT ? page.pagination?.next_cursor : null
      await sleep(250)
    } while (cursor)
  }

  return [...sales.values()]
}

// Búsquedas "(nombre, nombre, ...)" con todos los jugadores y alias
const buildQueries = (players, rules) => {
  const terms = [...players.map(([name]) => name), ...Object.keys(rules.aliases)]
    .map(name => name.replace(/[(),"]/g, ' ').trim())
    .filter(Boolean)

  const queries = []
  for (let i = 0; i < terms.length; i += NAMES_PER_QUERY) queries.push(`(${terms.slice(i, i + NAMES_PER_QUERY).join(',')})`)
  return queries
}

// Resumen de los últimos SUMMARY_DAYS días: mediana de las medianas diarias ponderada por nº de ventas
const summarize = (history, today) => {
  const recent = history.filter(([day]) => day > today - SUMMARY_DAYS)
  const last = history[history.length - 1]

  if(!recent.length) return { price: last[1], low: last[3], high: last[4], sales: 0, lastSale: toDate(last[0]) }

  const weighted = recent.flatMap(([, value, count]) => Array(Math.min(count, 50)).fill(value))
  return {
    price: median(weighted),
    low: Math.min(...recent.map(e => e[3])),
    high: Math.max(...recent.map(e => e[4])),
    sales: recent.reduce((sum, e) => sum + e[2], 0),
    lastSale: toDate(last[0]),
  }
}

// Tendencias del mercado (Explore > Trending): las cartas que más suben y bajan en 7 y 30 días
// (precio del último día con ventas frente al de antes del periodo) y las más caras (mediana de 30 días, con al
// menos TRENDS_MIN_SALES ventas). Solo cartas de al menos TRENDS_MIN_CENTS
const TRENDS_SIZE = 50
const TRENDS_MIN_CENTS = 500
const TRENDS_MIN_SALES = 2

const buildTrends = (files, today) => {
  const items = []

  for (const file of files.values()) {
    for (const card of file.cards) {
      for (const [grade, entry] of Object.entries(card.grades)) {
        const { key, year, set, number, parallel, printRun, auto, rookie, image } = card
        items.push({ slug: file.slug, name: file.name, team: file.team, key, grade, year, set, number, parallel, printRun, auto, rookie, image, entry })
      }
    }
  }

  const movers = (days) => items.map(({ entry, ...item }) => {
    const last = entry.history[entry.history.length - 1]
    const before = [...entry.history].reverse().find(e => e[0] <= today - days)
    if(!last || !before || before === last || before[1] < TRENDS_MIN_CENTS || last[1] < TRENDS_MIN_CENTS) return null
    return { ...item, price: last[1], from: before[1], change: Math.round((last[1] - before[1]) / before[1] * 1000) / 10 }
  }).filter(e => e && Math.abs(e.change) >= 1)

  const top = items
    .filter(({ entry }) => entry.price >= TRENDS_MIN_CENTS && entry.sales >= TRENDS_MIN_SALES)
    .map(({ entry, ...item }) => ({ ...item, price: entry.price, from: null, change: null }))
    .sort((a, b) => b.price - a.price)
    .slice(0, TRENDS_SIZE)

  const lists = { top }
  for (const days of [7, 30]) {
    const list = movers(days)
    lists[`rising${days}`] = list.filter(e => e.change > 0).sort((a, b) => b.change - a.change).slice(0, TRENDS_SIZE)
    lists[`falling${days}`] = list.filter(e => e.change < 0).sort((a, b) => a.change - b.change).slice(0, TRENDS_SIZE)
  }

  return { updated: new Date().toISOString(), epoch: EPOCH, lists }
}

const loadPlayerFiles = async (out) => {
  const files = new Map()
  let names = []
  try {
    names = await readdir(`${out}/p`)
  } catch (e) {}

  for (const name of names) {
    const data = await readJson(`${out}/p/${name}`)
    if(data) files.set(data.slug, data)
  }
  return files
}

// Añade las ventas de un día a las cartas de cada jugador (sustituye lo que hubiera de ese día)
const mergeDay = (files, date, cards, playerNames) => {
  const day = toDayNumber(date)
  // slug -> clave de variante -> { card, grades: { grado: [precios] } }
  const byPlayer = new Map()

  for (const card of cards) {
    if(!byPlayer.has(card.player)) byPlayer.set(card.player, new Map())
    const variants = byPlayer.get(card.player)
    const key = variantKey(card)
    if(!variants.has(key)) variants.set(key, { card, grades: {}, teams: [] })
    const variant = variants.get(key)
    ;(variant.grades[card.grade] ||= []).push(card.price)
    if(card.image && !variant.image) variant.image = card.image
    if(card.team) variant.teams.push(card.team)
  }

  // Quitar ese día de todas las cartas (por si se vuelve a procesar)
  for (const file of files.values()) {
    for (const card of file.cards) {
      for (const grade of Object.values(card.grades)) grade.history = grade.history.filter(e => e[0] !== day)
    }
  }

  for (const [slug, variants] of byPlayer) {
    if(!files.has(slug)) files.set(slug, { name: playerNames.get(slug), slug, team: null, epoch: EPOCH, cards: [] })
    const file = files.get(slug)
    const teams = []

    for (const [key, variant] of variants) {
      let card = file.cards.find(e => e.key === key)
      if(!card){
        const { year, set, number, parallel, printRun, auto, memorabilia } = variant.card
        card = { key, year, set, number, parallel, printRun, auto, memorabilia, rookie: false, image: null, grades: {} }
        file.cards.push(card)
      }
      card.rookie = card.rookie || variant.card.rookie
      card.memorabilia = card.memorabilia || variant.card.memorabilia
      if(variant.image) card.image = variant.image
      teams.push(...variant.teams)

      for (const [grade, prices] of Object.entries(variant.grades)) {
        const entry = card.grades[grade] ||= { history: [] }
        entry.history.push([day, median(prices), prices.length, Math.min(...prices), Math.max(...prices)])
        entry.history.sort((a, b) => a[0] - b[0])
      }
    }

    // El equipo que más aparece en las ventas del día
    if(teams.length){
      const counts = teams.reduce((acc, team) => ({ ...acc, [team]: (acc[team] || 0) + 1 }), {})
      file.team = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    }
  }
}

// Cambio del día (unidades de cada moneda por 1 USD) para pasar a dólares las ventas en otra moneda: desde
// agosto de 2026 la API da el precio en la moneda del anuncio (GBP, EUR, CAD...). Frankfurter (BCE, sin clave);
// si no responde, unos cambios aproximados
const FALLBACK_RATES = { EUR: 0.92, GBP: 0.78, CAD: 1.38, AUD: 1.52, JPY: 150, CHF: 0.88, NZD: 1.68, SEK: 10.5, DKK: 6.9, NOK: 10.8, PLN: 4, MXN: 18.5, HKD: 7.8, SGD: 1.34, CNY: 7.2 }
const loadRates = async () => {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD')
    const { rates } = await res.json()
    if(rates?.EUR) return rates
  } catch (e) {}
  console.log('::warning::Sin cambio de moneda del día: se usan los aproximados')
  return FALLBACK_RATES
}

const toUsd = (price, currency, rates) => {
  if(price == null || !(price > 0)) return null
  const code = (currency || 'USD').toUpperCase()
  if(code === 'USD') return price
  return rates[code] ? Math.round(price / rates[code] * 100) / 100 : null
}

// Lo que se guarda de cada venta en raw/ (lo que necesita readSales). price en USD; currency la original.
// set, number y year: los que da la API (se usan si el título no los dice)
const rawSale = (sale, rates) => ({
  title: sale.title,
  price: sale.price_usd ?? toUsd(sale.price, sale.currency, rates),
  currency: sale.currency || null,
  priceMissing: sale.price == null,
  grader: sale.grader || sale.grading_company || null,
  grade: sale.grade || null,
  sport: sale.sport || null,
  set: sale.card_set || null,
  number: sale.card_number || null,
  year: sale.year || null,
  image: sale.thumbnail_url || null,
})

// Número de la API (#27, BCP-100...) en el formato del parser
const apiNumber = (value) => {
  const number = String(value || '').replace(/^#\s*/, '').trim().toUpperCase()
  return /^[A-Z0-9]{1,6}(?:-[A-Z0-9]{1,6})?$/.test(number) ? number : null
}

const REJECT_SAMPLES = 15

// Cartas reconocidas en las ventas (en formato rawSale) y por qué se descartan las demás (para el log)
const readSales = (sales, { parse, findSet }, excluded) => {
  const cards = []
  const sports = {}
  const rejected = { otherSport: 0, noPrice: 0, noPriceReasons: {}, excluded: {}, noPlayer: [], noSetOrNumber: [] }
  let excludedCount = 0
  for (const sale of sales) {
    const sport = sale.sport || '(vacío)'
    sports[sport] = (sports[sport] || 0) + 1
    // Mismo nombre que un jugador de otro deporte (la búsqueda es por nombre)
    if(sale.sport && sale.sport !== SPORT){ rejected.otherSport++; continue }
    if(!sale.price || sale.price <= 0){
      rejected.noPrice++
      // Por qué: precio no publicado (ofertas aceptadas) o moneda sin cambio
      const reason = sale.priceMissing ? 'sin publicar' : (sale.currency || '?')
      rejected.noPriceReasons[reason] = (rejected.noPriceReasons[reason] || 0) + 1
      continue
    }
    const card = parse(sale.title, { grader: sale.grader, grade: sale.grade })
    if(!card){
      const text = normalizeText(sale.title)
      const word = excluded.find(w => text.includes(w))
      if(word){
        rejected.excluded[word.trim()] = (rejected.excluded[word.trim()] || 0) + 1
        excludedCount++
      } else rejected.noPlayer.push(sale.title)
      continue
    }
    // Lo que el título no dice, de los datos de la API
    if(!card.number && sale.number) card.number = apiNumber(sale.number)
    if(!card.set && sale.set) card.set = findSet(sale.set)
    if(!card.year && Number(sale.year) >= 1880) card.year = Number(sale.year)
    if(!card.set && !card.number){ rejected.noSetOrNumber.push(sale.title); continue }
    cards.push({ ...card, price: cents(sale.price), image: sale.image })
  }
  rejected.excludedCount = excludedCount
  return { cards, sports, rejected }
}

// Resumen de los descartes de un día, con ejemplos (anotación ::notice:: del log, se ve en la ejecución)
const rejectedNotice = (date, { otherSport, noPrice, noPriceReasons, excluded, excludedCount, noPlayer, noSetOrNumber }) => {
  const priceReasons = Object.entries(noPriceReasons || {}).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')
  const sample = (titles) => titles.slice(0, REJECT_SAMPLES).map(t => String(t).slice(0, 90).replace(/%/g, '%25').replace(/[\r\n]+/g, ' ')).join(' ¦ ')
  const words = Object.entries(excluded).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w, n]) => `${w} ${n}`).join(', ')
  return `::notice::${date} descartadas: otro deporte ${otherSport}, sin precio ${noPrice} (${priceReasons}), palabra excluida ${excludedCount} (${words})` +
    ` %0A· sin jugador ${noPlayer.length}: ${sample(noPlayer)}` +
    ` %0A· sin set ni número ${noSetOrNumber.length}: ${sample(noSetOrNumber)}`
}

// Ventas del día con varios precios mínimos (cada uno gasta una fila por búsqueda)
const estimate = async (date, queries) => {
  for (const floor of PRICE_FLOORS.slice(0, 5)) {
    console.log(`${date}: ${await countDay(date, queries, floor)} ventas de ${floor} USD o más`)
  }
  console.log(`Plan: ${rowsLimit} filas al día, quedan ${rowsRemaining} hoy`)
}

const main = async () => {
  const out = process.argv[2]
  if(!out) throw new Error('Uso: node build.mjs <carpeta de salida> | --estimate [YYYY-MM-DD]')
  if(!API_KEY) throw new Error('Falta THECARDAPI_KEY')

  const players = await readJson('data/players.json')
  const rules = await readJson('data/rules.json')

  if(out === '--estimate') return estimate(process.argv[3] || toDate(todayNumber() - 1), buildQueries(players, rules))
  const parser = createParser({ players, rules })
  const excluded = rules.excluded.map(word => normalizeText(word))
  // Versión del parser y sus listas: si cambia, se vuelven a leer los días guardados en raw/
  const parserVersion = createHash('sha1').update(await readFile('cardParser.js')).update(JSON.stringify(rules)).update(JSON.stringify(players)).digest('hex').slice(0, 12)
  // Días leídos en esta ejecución (no hace falta volver a leerlos)
  const readNow = new Set()
  // Cambio de moneda del día (se pide solo si hay ventas nuevas)
  let rates = null
  const playerNames = new Map(players.map(([name, slug]) => [slug, name]))

  const index = (await readJson(`${out}/index.json`)) || { days: {} }
  const today = todayNumber()

  // Días por procesar: los de los últimos LOOKBACK_DAYS que no estén hechos, sin ayer (aún pueden llegar
  // ventas). Cada día se descarga una sola vez, ya completo: un día de béisbol gasta casi todas las filas
  // diarias del plan y no se puede pagar dos veces (en basketball-prices ayer se procesa como 'partial' y se
  // repite al día siguiente). Del más reciente al más antiguo: el más antiguo está en el límite del plan
  // (date_from se recorta a lo que permite) y solo se usa para recuperar un día que no se pudo hacer
  // También se repiten los ya hechos con un precio mínimo más alto del más bajo posible: entran las ventas más
  // baratas si ahora caben (los días hechos antes del precio mínimo automático no lo tienen guardado: 8 USD)
  // Y los hechos antes de pasar a USD las ventas en otra moneda (index.usd), con el mismo precio mínimo o uno más bajo
  const previousFloor = (date) => index.days[date] !== 'final' ? Infinity : (index.minPrice?.[date] ?? LEGACY_MIN_PRICE)
  const withoutUsd = (date) => index.days[date] === 'final' && !index.usd?.[date]
  const pending = []
  for (let day = today - 2; day >= today - LOOKBACK_DAYS; day--) {
    const date = toDate(day)
    if(FORCE || previousFloor(date) > PRICE_FLOORS[0] || withoutUsd(date)) pending.push(date)
  }

  const files = await loadPlayerFiles(out)
  const queries = buildQueries(players, rules)
  let processed = 0

  for (const date of pending) {
    let sales
    let minPrice = null
    const done = index.days[date] === 'final'
    // Uno ya hecho solo se repite con un precio mínimo más bajo que el que tiene
    const floors = PRICE_FLOORS.filter(floor => FORCE || floor < previousFloor(date) || (withoutUsd(date) && floor <= previousFloor(date)))
    try {
      // El precio mínimo más bajo con el que el día cabe en lo que queda del plan (un día a medias no se guarda).
      // Se deja margen para la página extra de las búsquedas con más de PAGE_LIMIT ventas
      for (const floor of floors) {
        // Sin cuota para contar y descargar algo útil, no se gasta más en recuentos
        if(rowsRemaining < queries.length * 4) break
        const total = await countDay(date, queries, floor)
        if(total + queries.length * 2 <= rowsRemaining){
          minPrice = floor
          break
        }
      }
      if(minPrice === null){
        // Uno ya hecho se queda como está (se intentará mejorar en otra ejecución); uno pendiente, en la siguiente
        if(done){
          console.log(`${date}: sigue con ${previousFloor(date)} USD (no cabe uno más bajo en las ${rowsRemaining} filas que quedan)`)
          continue
        }
        console.log(`::warning::${date}: no cabe en las ${rowsRemaining} filas que quedan hoy: se procesará en la siguiente ejecución`)
        break
      }
      sales = await fetchDay(date, queries, minPrice)
    } catch (e) {
      // Un día a medias no se guarda: se vuelve a intentar entero en la siguiente ejecución
      console.log(`::warning::${date}: ${e.message}`)
      if(e instanceof BudgetError) break
      continue
    }

    rates ||= await loadRates()
    const raw = sales.map(sale => rawSale(sale, rates))
    await mkdir(RAW_DIR, { recursive: true })
    await writeFile(`${RAW_DIR}/${date}.json`, JSON.stringify(raw))
    // sports: deporte que pone la API en las ventas (en el log, para ver si se puede filtrar solo por él)
    const { cards, sports, rejected } = readSales(raw, parser, excluded)
    readNow.add(date)

    mergeDay(files, date, cards, playerNames)
    index.days[date] = 'final'
    // Precio mínimo con el que se procesó cada día
    ;(index.minPrice ||= {})[date] = minPrice
    // Ya con las ventas en otra moneda pasadas a USD
    ;(index.usd ||= {})[date] = true
    processed++
    console.log(`${date}: ${sales.length} ventas desde ${minPrice} USD, ${cards.length} reconocidas (quedan ${rowsRemaining} filas hoy)`)
    console.log(`::notice::${date}: ${sales.length} ventas desde ${minPrice} USD, ${cards.length} reconocidas. Deporte: ${Object.entries(sports).sort((a, b) => b[1] - a[1]).map(([sport, count]) => `${sport} ${count}`).join(', ')}`)
    console.log(rejectedNotice(date, rejected))
  }

  // Si ha cambiado el parser (cardParser.js, rules.json o players.json), los días guardados en raw/ se vuelven a
  // leer: las mejoras llegan también a los días ya procesados sin gastar filas
  let reread = 0
  if(index.parser !== parserVersion){
    let rawFiles = []
    try {
      rawFiles = (await readdir(RAW_DIR)).filter(name => name.endsWith('.json'))
    } catch (e) {}
    for (const name of rawFiles.sort()) {
      const date = name.slice(0, -5)
      if(readNow.has(date) || index.days[date] !== 'final') continue
      const raw = await readJson(`${RAW_DIR}/${name}`)
      if(!raw) continue
      const { cards } = readSales(raw, parser, excluded)
      mergeDay(files, date, cards, playerNames)
      reread++
      console.log(`${date}: releído con el parser nuevo, ${raw.length} ventas, ${cards.length} reconocidas`)
    }
    index.parser = parserVersion
  }

  // Las ventas en bruto solo hacen falta RAW_DAYS días
  try {
    for (const name of await readdir(RAW_DIR)) {
      if(toDayNumber(name.slice(0, 10)) <= today - RAW_DAYS) await rm(`${RAW_DIR}/${name}`)
    }
  } catch (e) {}

  // Sin días nuevos no hace falta publicar, salvo que falte algún archivo (uno nuevo del feed, como trends.json)
  const complete = (await readJson(`${out}/trends.json`)) && index.teams
  if(!processed && !reread && !FORCE && complete){
    console.log('Sin días nuevos')
    return
  }

  // Resúmenes (cambian cada día aunque no haya ventas nuevas: la ventana de SUMMARY_DAYS avanza)
  await rm(`${out}/p`, { recursive: true, force: true })
  await mkdir(`${out}/p`, { recursive: true })
  index.players = {}
  index.teams = {}

  for (const file of files.values()) {
    for (const card of file.cards) {
      for (const [grade, entry] of Object.entries(card.grades)) {
        entry.history = entry.history.filter(e => e[0] > today - HISTORY_DAYS)
        if(!entry.history.length){
          delete card.grades[grade]
          continue
        }
        Object.assign(entry, summarize(entry.history, today))
      }
    }
    file.cards = file.cards.filter(card => Object.keys(card.grades).length)
    if(!file.cards.length) continue

    const cardSales = (card) => Object.values(card.grades).reduce((sum, e) => sum + e.sales, 0)
    file.cards.sort((a, b) => cardSales(b) - cardSales(a))

    await writeFile(`${out}/p/${file.slug}.json`, JSON.stringify(file))
    index.players[file.slug] = file.cards.length
    if(file.team) index.teams[file.slug] = file.team
  }

  for (const date of Object.keys(index.days)) {
    if(toDayNumber(date) <= today - HISTORY_DAYS){
      delete index.days[date]
      if(index.minPrice) delete index.minPrice[date]
      if(index.usd) delete index.usd[date]
    }
  }
  index.updated = new Date().toISOString()
  index.epoch = EPOCH

  await writeFile(`${out}/index.json`, JSON.stringify(index))
  await writeFile(`${out}/players.json`, JSON.stringify(players))
  await writeFile(`${out}/rules.json`, JSON.stringify(rules))
  await writeFile(`${out}/trends.json`, JSON.stringify(buildTrends(files, today)))

  if(process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'changed=true\n')
  console.log(`${Object.keys(index.players).length} jugadores con precios`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
