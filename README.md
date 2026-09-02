# MTG Collection Value Tracker

A free, self-hosted web app for tracking the value of a Magic: The Gathering
collection over time, plus per-card price history.

## Status

Pre-alpha. Phase 0 (project scaffolding) only.

## Features (v1 scope)

- **Portfolio tracking** — add printings to a collection (quantity, finish,
  condition, date added) and chart total collection value over time.
- **Card price history** — look up any single printing and view its price chart.

Single-user, USD-only, no account system.

## Data sources

- [Scryfall](https://scryfall.com/docs/api) bulk data — card metadata and the
  ongoing daily price snapshot (`prices.usd` / `prices.usd_foil`, sourced from
  TCGplayer).
- [MTGJSON](https://mtgjson.com/) `AllPrices` — one-time 90-day historical
  backfill, `tcgplayer` retail series only, joined to Scryfall IDs through
  `AllIdentifiers`.

This project is not affiliated with, endorsed, or sponsored by Wizards of the
Coast, Scryfall, MTGJSON, or TCGplayer.

## Stack

Next.js (TypeScript, App Router) · SQLite via Drizzle ORM · Recharts · node-cron
· Docker Compose

## Development

```bash
npm install
npm run dev
```

## License

Copyright (C) 2026 Nathan Manske

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.

AGPLv3 is deliberate: anyone who runs a modified version of this as a network
service must also offer its source to users interacting with it over the
network. See [`LICENSE`](LICENSE) for the full text.
