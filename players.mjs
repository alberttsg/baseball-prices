// Genera data/players.json (jugadores de béisbol) a partir del registro de personas de Chadwick Bureau
// (github.com/chadwickbureau/register) y del draft de la MLB (statsapi.mlb.com). Se ejecuta a mano de vez en
// cuando (al empezar cada temporada y después del draft, para los prospects nuevos):
//   node players.mjs
// Formato: [[nombre, slug, activo], ...] ordenado por slug
//
// Entran:
// - Todos los que han jugado en la MLB (desde el siglo XIX: las cartas vintage son una parte grande del mercado)
// - Los que han jugado en ligas menores las últimas PROSPECT_SEASONS temporadas (Bowman: cartas de prospects)
// - Los elegidos en los últimos DRAFT_YEARS drafts (aún sin jugar como profesionales)
// activo: ha jugado (MLB o menores) esta temporada o la anterior, o es del último draft

import { writeFile } from 'node:fs/promises'
import { slugify } from './cardParser.js'

const REGISTER_URL = 'https://raw.githubusercontent.com/chadwickbureau/register/master/data'
const REGISTER_FILES = [...'0123456789abcdef'].map(e => `people-${e}.csv`)
const STATS_URL = 'https://statsapi.mlb.com/api/v1'

// En Chadwick el sufijo (Jr.) falta en muchos jugadores recientes (Vladimir Guerrero Jr. sale como Vladimir
// Guerrero, igual que su padre): para los que han jugado desde NAME_SEASONS_FROM se usa el nombre de la MLB
const NAME_SEASONS_FROM = 1990
// MLB, AAA, AA, A+ y A
const MLB_SPORT = 1
const MINOR_SPORTS = [11, 12, 13, 14]

const PROSPECT_SEASONS = 2
const DRAFT_YEARS = 2

const thisYear = new Date().getUTCFullYear()

// CSV con comillas ("Smith, Jr.")
const parseCsv = (text) => {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if(quoted){
      if(char === '"' && text[i + 1] === '"'){
        field += '"'
        i++
      }else if(char === '"') quoted = false
      else field += char
    }else if(char === '"') quoted = true
    else if(char === ','){
      row.push(field)
      field = ''
    }else if(char === '\n'){
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    }else field += char
  }
  if(field || row.length) rows.push([...row, field])

  const [header, ...data] = rows
  return data.map(values => Object.fromEntries(header.map((name, i) => [name, values[i] || ''])))
}

const getText = async (url) => {
  const res = await fetch(url)
  if(!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

const getJson = async (url) => JSON.parse(await getText(url))

// id de la MLB (key_mlbam) -> nombre completo según la MLB
const getMlbNames = async () => {
  const names = new Map()
  const requests = []
  for (let season = NAME_SEASONS_FROM; season <= thisYear; season++) requests.push([MLB_SPORT, season])
  for (let season = thisYear - PROSPECT_SEASONS + 1; season <= thisYear; season++) {
    for (const sport of MINOR_SPORTS) requests.push([sport, season])
  }

  for (const [sport, season] of requests) {
    try {
      const data = await getJson(`${STATS_URL}/sports/${sport}/players?season=${season}&fields=people,id,fullName`)
      for (const person of data.people || []) names.set(String(person.id), person.fullName)
    } catch (e) {
      console.log(`Jugadores ${sport}/${season}: ${e.message}`)
    }
  }
  return names
}

const fullName = (first, last, suffix) => [first, last, suffix].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()

const main = async () => {
  // slug -> { name, active, rank }: con el mismo nombre (dos Frank Thomas, Alex Rodriguez) se queda uno: el que
  // ha jugado en la MLB antes que el de ligas menores, después el que está en activo y después el de la carrera
  // más larga en la MLB (el más conocido, el de las cartas)
  const bySlug = new Map()
  const add = (fullName, active, mlbYears) => {
    // Sin "Sr.": en las cartas del padre no aparece (Ken Griffey, Pete Rose)
    const name = fullName.replace(/ Sr\.?$/, '')
    const slug = slugify(name)
    if(!slug) return
    const rank = (mlbYears > 0 ? 1e6 : 0) + active * 1e3 + mlbYears
    const current = bySlug.get(slug)
    if(!current || rank > current.rank) bySlug.set(slug, { name, active, rank })
  }

  const mlbNames = await getMlbNames()

  let mlb = 0
  let prospects = 0
  for (const file of REGISTER_FILES) {
    for (const person of parseCsv(await getText(`${REGISTER_URL}/${file}`))) {
      if(!person.name_last || !person.name_first) continue
      const name = mlbNames.get(person.key_mlbam) || fullName(person.name_first, person.name_last, person.name_suffix)
      const mlbFirst = Number(person.mlb_played_first)
      const mlbLast = Number(person.mlb_played_last)
      const proLast = Number(person.pro_played_last)
      const active = Math.max(mlbLast || 0, proLast || 0) >= thisYear - 1 ? 1 : 0

      if(mlbFirst){
        add(name, active, mlbLast - mlbFirst + 1)
        mlb++
      }else if(proLast >= thisYear - PROSPECT_SEASONS + 1 && person.key_mlbam){
        add(name, active, 0)
        prospects++
      }
    }
  }

  let drafted = 0
  for (let year = thisYear - DRAFT_YEARS + 1; year <= thisYear; year++) {
    let data
    try {
      data = await getJson(`${STATS_URL}/draft/${year}`)
    } catch (e) {
      console.log(`Draft ${year}: ${e.message}`)
      continue
    }
    for (const round of data.drafts?.rounds || []) {
      for (const pick of round.picks || []) {
        const name = pick.person?.fullName
        if(!name) continue
        add(name, 1, 0)
        drafted++
      }
    }
  }

  const players = [...bySlug.entries()]
    .map(([slug, e]) => [e.name, slug, e.active])
    .sort((a, b) => a[1].localeCompare(b[1]))

  await writeFile('data/players.json', `[\n${players.map(e => JSON.stringify(e)).join(',\n')}\n]\n`)
  console.log(`${players.length} jugadores (${mlb} MLB, ${prospects} prospects, ${drafted} del draft; ${players.filter(e => e[2]).length} en activo)`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
