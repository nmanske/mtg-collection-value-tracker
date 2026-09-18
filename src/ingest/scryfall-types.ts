/**
 * The subset of Scryfall's bulk-data and card objects this app reads.
 *
 * Verified against the live API on 2026-09-09. Two things differ from older
 * documentation: bulk entries expose `jsonl_download_uri` (gzipped JSON Lines)
 * rather than a `download_uri` to a single JSON array, and `finishes` uses
 * `nonfoil` rather than `normal`.
 */

export interface ScryfallBulkEntry {
  id: string;
  type: string;
  name: string;
  updated_at: string;
  jsonl_download_uri: string;
  compressed_size?: number;
}

export interface ScryfallBulkIndex {
  object: "list";
  data: ScryfallBulkEntry[];
}

export interface ScryfallPrices {
  usd: string | null;
  usd_foil: string | null;
  usd_etched: string | null;
  eur: string | null;
  eur_foil: string | null;
  tix: string | null;
}

export interface ScryfallImageUris {
  small?: string;
  normal?: string;
  large?: string;
  png?: string;
}

export interface ScryfallCardFace {
  name: string;
  image_uris?: ScryfallImageUris;
  oracle_id?: string;
}

export interface ScryfallCard {
  object: "card";
  id: string;
  /** Absent on `reversible_card` layouts, where it sits on each face instead. */
  oracle_id?: string;
  name: string;
  lang: string;
  set: string;
  set_name: string;
  /** `YYYY-MM-DD`. Present on every paper card. */
  released_at?: string;
  collector_number: string;
  layout: string;
  /** `paper`, `mtgo`, `arena`. Printings without `paper` have no paper price. */
  games: string[];
  digital: boolean;
  finishes: string[];
  /** Absent on multi-faced layouts, which carry images per face. */
  image_uris?: ScryfallImageUris;
  card_faces?: ScryfallCardFace[];
  prices: ScryfallPrices;
}
