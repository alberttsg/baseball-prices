# baseball-prices

Precios diarios de cartas de béisbol para la app de escáner de cartas de baseball, a partir de las ventas de
[TheCardAPI](https://www.thecardapi.com) (eBay, Fanatics Collect, Goldin...). Es el mismo sistema que
`basketball-prices`.

Una tarea de GitHub Actions (`.github/workflows/update-prices.yml`) ejecuta cada día `node build.mjs public` y
publica el resultado en la rama `gh-pages` (GitHub Pages). El formato de los archivos está al principio de
`build.mjs`. Solo se publica el resumen diario de cada carta, no las ventas sueltas.

## Archivos

- `build.mjs`: descarga las ventas, las agrupa por carta y genera el feed.
- `cardParser.js`: lee jugador, año, set, número, parallel, tirada y grado de un texto. **Es el mismo archivo que
  usa la app** (`baseball/Components/Prices/cardParser.js`): si se cambia aquí, hay que copiarlo allí.
- `data/players.json`: jugadores de la MLB (todos, desde el siglo XIX), de ligas menores de las dos últimas
  temporadas y de los dos últimos drafts (registro de [Chadwick Bureau](https://github.com/chadwickbureau/register)
  y `statsapi.mlb.com`). Se regenera con `node players.mjs` al empezar cada temporada y después del draft.
- `data/rules.json`: sets, parallels, equipos, alias de jugadores y palabras que descartan una venta. La app
  lo descarga del feed, así que los cambios llegan sin publicar una versión nueva.

## Configuración en GitHub

1. Secreto del repositorio `THECARDAPI_KEY` (Settings > Secrets and variables > Actions).
2. Variable del repositorio `LOOKBACK_DAYS`: días hacia atrás del plan de TheCardAPI (gratis: 3, Starter: 14).
3. Variable del repositorio `MIN_PRICE` (opcional): precio mínimo en USD de las ventas que se piden. El béisbol
   tiene muchas más ventas que el baloncesto; si un día no cabe en las filas diarias del plan, el log lo avisa.
4. Settings > Pages: rama `gh-pages`, carpeta `/` (después de la primera ejecución).

Si la clave es la misma que la de `basketball-prices`, las filas diarias del plan se reparten entre los dos.

A diferencia de `basketball-prices`, cada día se procesa una sola vez y cuando ya está cerrado (de anteayer
hacia atrás): un día de béisbol gasta casi todas las filas diarias del plan. Los precios llegan con dos días de
retraso.

## Probar en local

```
# Cuántas filas gasta un día (una fila por búsqueda)
THECARDAPI_KEY=... node build.mjs --estimate
THECARDAPI_KEY=... MIN_PRICE=5 node build.mjs --estimate

THECARDAPI_KEY=... LOOKBACK_DAYS=1 node build.mjs public
```
