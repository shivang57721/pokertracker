# PokerTracker — Project Context

## What this is
A personal poker hand history tracker. Parses PokerStars hand history files, stores hands in a local SQLite database, and displays stats + hand replay in a web UI. The hero player is `FlaminGalah12` (hardcoded in `client/src/App.jsx`).

## How to run
```bash
# Server (port 3001)
cd server && node src/index.js

# Client (port 5173)
cd client && npm run dev
```

The Vite dev server proxies `/api` → `http://localhost:3001`. On startup the server auto-imports any new hand history files and starts a file watcher for live updates.

---

## Architecture

### Stack
- **Server**: Node.js + Express, port 3001
- **Client**: React 19 + Vite + Tailwind CSS v4
- **Database**: `sql.js` (pure WebAssembly SQLite — in-memory, flushed to `server/poker.db` via `saveDb()` after every write)
- **Charts**: recharts (LineChart with Brush zoom)

### Key constraint — sql.js
`sql.js` is an in-memory SQLite port. Every write must be followed by `saveDb()` or data is lost on restart. Queries use positional `?` params via `db.prepare(sql).run([params])`. Use `queryAll(db, sql, params)` and `queryOne(db, sql, params)` helpers from `db.js` for reads.

### Database schema (`server/src/db.js`)
Three tables:

```sql
hands (
  hand_id TEXT UNIQUE,      -- PokerStars hand number
  tournament_id TEXT,
  is_tournament INTEGER,    -- 0=cash, 1=tournament
  game_type TEXT,
  stakes TEXT,
  small_blind REAL,
  big_blind REAL,
  date_played TEXT,
  table_name TEXT,
  max_seats INTEGER,
  button_seat INTEGER,
  total_pot REAL,
  rake REAL,
  board TEXT,               -- JSON array e.g. ["2c","4s","3c"]
  raw_text TEXT             -- original hand history text
)

hand_players (
  hand_id TEXT,
  seat INTEGER,
  player TEXT,
  starting_chips REAL,
  position TEXT,            -- 'button'|'small blind'|'big blind'|'utg'|'hj'|'co' etc.
  hole_cards TEXT,          -- JSON array
  amount_won REAL,
  did_muck INTEGER
)

hand_actions (
  hand_id TEXT,
  street TEXT,              -- preflop|flop|turn|river|showdown
  action_order INTEGER,
  player TEXT,
  action TEXT,              -- fold|check|call|bet|raise|post_sb|post_bb|post_ante
  amount REAL,              -- chips added to pot
  total_amount REAL,        -- total street commitment after action (for raises)
  is_all_in INTEGER
)
```

### Server files (`server/src/`)
| File | Purpose |
|---|---|
| `index.js` | Express routes — all API endpoints |
| `db.js` | sql.js init, schema, `queryAll`/`queryOne` helpers, `saveDb` |
| `parser.js` | PokerStars hand history parser; `assignPositions()` calculates all positions from seat layout |
| `importer.js` | Reads `.txt` files from hand history directory, deduplicates, calls parser |
| `watcher.js` | `chokidar` file watcher — imports new hands live |
| `stats.js` | `computeStats`, `computeSessions`, `computeProfitCurve`, `getAvailableFilters` |
| `reparse-positions.js` | One-off script: re-reads raw_text for all hands, recomputes positions, updates DB |

### API endpoints
```
GET  /api/health
GET  /api/hands                        ?player=&limit=&offset=&from=&to=&stakes=&game_type=&is_tournament=0|1&sort_by=&sort_dir=&min_net=&max_net=
GET  /api/hands/:handId                full detail with players + actions
GET  /api/stats/:player                ?from=&to=&game_type=&stakes=&is_tournament=0|1
GET  /api/stats/:player/sessions       same filters
GET  /api/stats/:player/profit-curve   same filters → { cash: [...], tournament: [...] }
GET  /api/stats/:player/filters        distinct game_types, stakes (with is_tournament flag), date range
POST /api/import                       { path? } — trigger manual re-import
POST /api/reparse-positions            recompute all positions from raw_text
```

`GET /api/hands` with `player=` param computes per-row `net_profit`, `hole_cards`, `player_position` via a subquery wrapper (needed so `net_profit` can be used in ORDER BY / WHERE).

`net_profit` = `amount_won - SUM(invested actions)`. For cash hands this is USD; for tournaments it's chips.

### Client files (`client/src/`)
```
App.jsx                     — root: mode toggle, filters, tab nav, data fetching
lib/api.js                  — fetch wrappers for all endpoints
lib/format.js               — fmtUSD, fmtInt, fmtNum, fmtPct, fmtStakes, fmtDateTime, fmtRelative, fmtDuration, parseCards
lib/benchmarks.js           — STATS_META (7 stats with quality ranges) and QUALITY_STYLE

components/
  FilterBar.jsx             — date range + stakes (cash only) + game type dropdowns
  SummaryBar.jsx            — summary tiles, mode-aware (cash: USD net/BB100; tournament: chip delta)
  StatsGrid.jsx             — 7 stat tiles with green/yellow/red quality colouring
  ProfitChart.jsx           — cumulative P&L line chart with Brush zoom; mode-aware
  HandBrowser.jsx           — sortable/filterable/paginated hand table + HandReplay
  HandReplay.jsx            — right-side drawer, street-by-street action replay
  SessionHistory.jsx        — session cards with sparklines, filters, pagination
  Sparkline.jsx             — pure SVG sparkline component
  HoleCards.jsx             — renders card array with 4-colour suit symbols
```

---

## Cash vs Tournament separation

The app has a **mode toggle** (`'cash'` | `'tournament'`) that appears in two places:

1. **Dashboard** (`App.jsx`) — in the sticky header, drives all data fetching via `is_tournament: mode === 'cash' ? '0' : '1'`. Stakes filter only shown in cash mode.
2. **Hand Browser** (`HandBrowser.jsx`) — same toggle style, same behaviour. Stakes filter (cash-only stakes) shown in cash mode; hidden in tournament mode.

Toggle style (must be consistent in both places):
```jsx
<div className="flex rounded-xl border border-gray-700 overflow-hidden shrink-0 shadow-md">
  <button className={`flex items-center gap-2 px-5 py-2 text-sm font-semibold transition-colors
    ${mode === 'cash' ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
    <span>💵</span> Cash
  </button>
  <button className={`flex items-center gap-2 px-5 py-2 text-sm font-semibold transition-colors
    ${mode === 'tournament' ? 'bg-yellow-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
    <span>🏆</span> Tournament
  </button>
</div>
```

- Cash result formatting: `fmtUSD(net_profit)`
- Tournament result formatting: `+1,250 chips` / `-800 chips` (signed integer chips)

---

## Position assignment (`parser.js`)

`assignPositions(players, actions, buttonSeat)` assigns positions to all active players (those with actions or hole cards). Seats sorted ascending (clockwise on PokerStars), rotated from button index, then mapped via `POSITION_NAMES`:

```js
POSITION_NAMES = {
  2: ['button', 'big blind'],
  3: ['button', 'small blind', 'big blind'],
  4: ['button', 'small blind', 'big blind', 'co'],
  5: ['button', 'small blind', 'big blind', 'utg', 'co'],
  6: ['button', 'small blind', 'big blind', 'utg', 'hj', 'co'],
  7: ['button', 'small blind', 'big blind', 'utg', 'utg+1', 'hj', 'co'],
  8: ['button', 'small blind', 'big blind', 'utg', 'utg+1', 'mp', 'hj', 'co'],
  9: ['button', 'small blind', 'big blind', 'utg', 'utg+1', 'mp', 'lj', 'hj', 'co'],
}
```

To recompute positions for existing hands: `node server/src/reparse-positions.js`

---

## Stats computed (`stats.js`)

`computeStats` returns:
- `total_hands`, `cash_hands`, `tourn_hands`
- `preflop`: `vpip`, `pfr`, `three_bet` (percentages, 1 decimal)
- `postflop`: `af` (aggression factor), `wtsd`, `w_sd`, `cbet`
- `profit`: `cash_net_usd`, `bb_100`, `tourn_net_chips`

`computeSessions` groups hands with <30 min idle gap into sessions. Returns per-session: `start`, `end`, `duration_min`, `hand_count`, `tables` (array), `net_profit`, `bb_100`, `sparkline` (running net starting at 0).

`computeProfitCurve` returns `{ cash: [{date, cumulative},...], tournament: [{date, cumulative},...] }`.

---

## Tailwind v4 notes
- Plugin: `@tailwindcss/vite` (not the PostCSS plugin)
- Import in CSS: `@import "tailwindcss"` (not `@tailwind base` etc.)
- **Full class strings required** — no dynamic construction like `` `text-${color}-400` ``. All conditional classes must be complete strings so Tailwind can detect them at build time.

---

## Things that have been fixed / known quirks
- `fmtPct` already appends `%` — `STATS_META` entries have `unit: ''` to avoid double `%%`
- `net_profit` alias can't be used in WHERE in the same query — wrapped in a subquery in `GET /api/hands`
- Stats queries use JOIN-based approach instead of `IN (?)` to avoid SQLite's 999-variable limit
- `computeSessions` `sparkline` starts with `[0]` so the line always begins at breakeven
- Tags feature was removed entirely — no `useTags` hook, no tag columns, no `RecentHands` component
- Recent Hands section removed from dashboard (Hand Browser covers this)
- Dashboard layout order: SummaryBar → StatsGrid → ProfitChart
