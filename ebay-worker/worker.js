// Precios de anuncios activos de eBay para las cartas sin ventas recientes en el feed (Cloudflare Worker).
// La app no puede llevar la clave de eBay: este Worker la guarda (secretos EBAY_CLIENT_ID y EBAY_CLIENT_SECRET),
// busca en la Browse API de eBay (anuncios de "cómpralo ya" en EE. UU., categoría de cartas sueltas) y devuelve
// la mediana de los precios. Cada búsqueda se guarda un día en la caché de Cloudflare.
//
//   GET /listings?q=2023 Topps Aaron Judge 27&grade=Raw&player=Aaron Judge&year=2023&number=27
//   (grade: Raw, PSA 10, BGS 9.5...; player/year/number opcionales: los anuncios tienen que coincidir)
//   -> { count, price, low, high, items: [{ title, price, url, image }] }   (precios en USD; price: mediana)
//
// eBay ya no da gratis las ventas cerradas (la API de vendidos es solo para socios): son precios pedidos.

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
// Sports Trading Card Singles
const CATEGORY_ID = '261328'
const CACHE_SECONDS = 24 * 3600
const MAX_ITEMS = 10

// Anuncios que no son una carta suelta de verdad
const EXCLUDED = /\b(lot|lots|you pick|pick your|choose|complete set|team set|reprint|rp|facsimile|custom|proxy|digital|box|pack|break|random)\b/i
const GRADED = /\b(psa|bgs|beckett|sgc|cgc|csg|hga|tag|dsg|isa|ksa|gma|mnt|ags)\s*(gem\s*(mint|mt)\s*)?\d/i

// Otra colección o una versión especial de la carta, que valen otra cosa: fuera si la búsqueda no las pide
// ("2022 Topps #84" no es "2022 Topps Heritage #84" ni la Refractor ni una numerada /875)
const OTHER_PRODUCTS = ['heritage', 'chrome', 'archives', 'finest', 'bowman', 'stadium club', 'gypsy queen', 'allen ginter', 'allen & ginter', 'inception', 'platinum', 'opening day', 'big league', 'gallery', 'tribute', 'museum', 'sterling', 'dynasty', 'pristine', 'fire', 'holiday', 'topps now', 'update', 'mini', 'sticker', 'national baseball card day', 'mega box', 'living set']
const SPECIAL_VERSIONS = ['refractor', 'foilboard', 'foil', 'rainbow', 'sparkle', 'parallel', 'variation', 'ssp', 'sp', 'short print', 'prizm', 'mojo', 'wave', 'shimmer', 'holo', 'auto', 'autograph', 'patch', 'relic', 'jersey card', 'printing plate', '1/1']
const SERIAL = /(?:^|\s|#)\/\s*\d{1,4}\b|\b\d{1,4}\s*\/\s*\d{1,4}\b/

// Token de aplicación (dura 2 horas): se reutiliza mientras el Worker siga vivo
let token = null
let tokenExpires = 0

const getToken = async (env) => {
  if(token && Date.now() < tokenExpires) return token
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`)}`,
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  })
  if(!res.ok) throw new Error(`token ${res.status} ${await res.text()}`)
  const data = await res.json()
  token = data.access_token
  tokenExpires = Date.now() + (data.expires_in - 300) * 1000
  return token
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const round = (value) => Math.round(value * 100) / 100

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
})

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const words = (text) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) || []

// ¿El anuncio es esta carta? Mismo jugador (todas sus palabras), mismo año (el primero del título: "2024 Topps
// ... 2023 Greatest Hits" es de 2024) y mismo número (#27, No. 27 o 27 suelto; no "GH-27" ni "27/99")
const hasPhrase = (text, phrase) => new RegExp(`(?:^|[^a-z0-9])${escape(phrase)}(?![a-z0-9])`).test(text)

const matches = (title, { player, year, number, q }) => {
  const titleWords = new Set(words(title))
  const lowerTitle = title.toLowerCase()
  const lowerQ = q.toLowerCase()
  const unwanted = [...OTHER_PRODUCTS, ...SPECIAL_VERSIONS].find(phrase => hasPhrase(lowerTitle, phrase) && !hasPhrase(lowerQ, phrase))
  if(unwanted) return false
  if(SERIAL.test(title) && !SERIAL.test(q)) return false
  if(player && !words(player).every(word => titleWords.has(word))) return false
  if(year){
    const firstYear = title.match(/\b(19[0-9]{2}|20[0-9]{2})(?:-\d{2})?\b/)
    if(!firstYear || firstYear[1] !== String(year)) return false
  }
  if(number){
    const n = escape(String(number).replace(/^#/, ''))
    const pattern = new RegExp(`(?:#\\s*|\\bno\\.?\\s*|(?:^|\\s))${n}(?![\\w/-])`, 'i')
    if(!pattern.test(title.replace(/[A-Za-z]+-\d+/g, ' '))) return false
  }
  return true
}

const search = async (env, q, grade, wanted) => {
  const params = new URLSearchParams({
    q: grade && grade !== 'Raw' ? `${q} ${grade}` : q,
    category_ids: CATEGORY_ID,
    filter: 'buyingOptions:{FIXED_PRICE},itemLocationCountry:US',
    limit: '50',
  })
  const res = await fetch(`${SEARCH_URL}?${params}`, {
    headers: { Authorization: `Bearer ${await getToken(env)}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
  })
  if(!res.ok) throw new Error(`search ${res.status} ${await res.text()}`)
  const data = await res.json()

  const wantsGraded = grade && grade !== 'Raw'
  const items = (data.itemSummaries || [])
    .filter(item => item.price?.currency === 'USD' && Number(item.price.value) > 0)
    .filter(item => !EXCLUDED.test(item.title))
    .filter(item => matches(item.title, { ...wanted, q }))
    // Sin gradear: fuera las gradeadas (valen otra cosa); gradeada: solo las de ese grado
    .filter(item => wantsGraded ? item.title.toLowerCase().includes(grade.toLowerCase()) : !GRADED.test(item.title))
    .map(item => ({ title: item.title, price: Number(item.price.value), url: item.itemWebUrl, image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null }))

  if(!items.length) return { count: 0, price: null, low: null, high: null, items: [] }

  // Sin los extremos (anuncios con precio absurdo): del percentil 10 al 90 si hay bastantes
  const prices = items.map(item => item.price).sort((a, b) => a - b)
  const trimmed = prices.length >= 10 ? prices.slice(Math.floor(prices.length * 0.1), Math.ceil(prices.length * 0.9)) : prices
  const byClosest = [...items].sort((a, b) => a.price - b.price)

  return {
    count: items.length,
    price: round(median(trimmed)),
    low: round(trimmed[0]),
    high: round(trimmed[trimmed.length - 1]),
    items: byClosest.slice(0, MAX_ITEMS),
  }
}

// ---- Identificar la carta por la foto (búsqueda por imagen de eBay, experimental) ----
//   POST /identify   body: { image: base64 (JPEG, mejor pequeña: ~600 px) }
//   -> { items: [{ title, price, url, image }] }   los anuncios que más se parecen, en el orden de eBay
// De sus títulos se saca el año, el set y el número de la carta (el frontal de las cartas actuales no los lleva)
const SEARCH_BY_IMAGE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search_by_image'
const MAX_IMAGE_CHARS = 1_500_000

const identify = async (env, image) => {
  const params = new URLSearchParams({ category_ids: CATEGORY_ID, limit: '20' })
  const res = await fetch(`${SEARCH_BY_IMAGE_URL}?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getToken(env)}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ image }),
  })
  if(!res.ok) throw new Error(`search_by_image ${res.status} ${await res.text()}`)
  const data = await res.json()
  return {
    items: (data.itemSummaries || []).map(item => ({
      title: item.title,
      price: Number(item.price?.value) || null,
      url: item.itemWebUrl,
      image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
    })),
  }
}

const handleIdentify = async (request, env) => {
  if(request.method !== 'POST') return json({ error: 'POST' }, 405)
  let image
  try {
    image = (await request.json()).image
  } catch (e) {
    return json({ error: 'body' }, 400)
  }
  if(typeof image !== 'string' || image.length < 100 || image.length > MAX_IMAGE_CHARS) return json({ error: 'image' }, 400)
  try {
    return new Response(JSON.stringify(await identify(env, image.replace(/^data:image\/\w+;base64,/, ''))), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    console.log(e.message)
    // Mientras se prueba: el motivo de eBay (p. ej. sin acceso a la búsqueda por imagen)
    return new Response(JSON.stringify({ error: 'ebay', detail: e.message.slice(0, 500) }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if(url.pathname === '/identify') return handleIdentify(request, env)
    if(url.pathname !== '/listings') return json({ error: 'not found' }, 404)

    const q = (url.searchParams.get('q') || '').trim().slice(0, 200)
    const grade = (url.searchParams.get('grade') || 'Raw').trim().slice(0, 20)
    if(q.length < 3) return json({ error: 'q' }, 400)

    // Caché de un día por búsqueda (la misma carta escaneada por muchos usuarios es una sola llamada a eBay)
    const wanted = {
      player: (url.searchParams.get('player') || '').trim().slice(0, 60),
      year: (url.searchParams.get('year') || '').trim().slice(0, 4),
      number: (url.searchParams.get('number') || '').trim().slice(0, 12),
    }
    const cacheKey = new Request(`https://cache.local/listings?q=${encodeURIComponent(q.toLowerCase())}&grade=${encodeURIComponent(grade)}&player=${encodeURIComponent(wanted.player.toLowerCase())}&year=${wanted.year}&number=${encodeURIComponent(wanted.number.toLowerCase())}`)
    const cached = await caches.default.match(cacheKey)
    if(cached) return cached

    try {
      const response = json(await search(env, q, grade, wanted))
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()))
      return response
    } catch (e) {
      console.log(e.message)
      return new Response(JSON.stringify({ error: 'ebay' }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }
  },
}
