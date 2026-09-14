/**
 * How the collection list is ordered and narrowed.
 *
 * The list was 3,724 holdings at 100 a page, ordered by acquisition date, with
 * no other control — 38 pages, and no way to answer "what are my most valuable
 * cards" or "show me my foils". The search page does not help: it searches
 * every printing in existence rather than the ones you own.
 *
 * Kept in one module so the query and the UI share a vocabulary. A sort the
 * page offers but the query cannot honour is a silent lie about what is on
 * screen, and that drift is easy when the two live apart.
 */

export const SORTS = [
  { id: "value", label: "Value", description: "most valuable first" },
  { id: "name", label: "Name", description: "A to Z" },
  { id: "acquired", label: "Acquired", description: "newest first" },
  { id: "quantity", label: "Copies", description: "most copies first" },
  { id: "set", label: "Set", description: "by set, then collector number" },
] as const;

export type SortId = (typeof SORTS)[number]["id"];
export const DEFAULT_SORT: SortId = "acquired";

/**
 * Narrowings worth offering, as opposed to every column being filterable.
 *
 * Each of these answers a question the collection actually raises: what is
 * foil, what has no price and is therefore missing from every total, and which
 * holdings carry an acquisition date that is inferred rather than known.
 */
export const FILTERS = [
  { id: "all", label: "All", description: "every holding" },
  { id: "foil", label: "Foil", description: "foil and etched printings" },
  {
    id: "unpriced",
    label: "Unpriced",
    description: "no price from any source, so absent from every total",
  },
  {
    id: "inferred",
    label: "Inferred date",
    description: "acquisition date is a floor, not a fact",
  },
] as const;

export type FilterId = (typeof FILTERS)[number]["id"];
export const DEFAULT_FILTER: FilterId = "all";

export function isSortId(value: string): value is SortId {
  return SORTS.some((sort) => sort.id === value);
}

export function isFilterId(value: string): value is FilterId {
  return FILTERS.some((filter) => filter.id === value);
}

export function resolveSort(value: string | undefined): SortId {
  return value && isSortId(value) ? value : DEFAULT_SORT;
}

export function resolveFilter(value: string | undefined): FilterId {
  return value && isFilterId(value) ? value : DEFAULT_FILTER;
}

/**
 * A query string carrying the controls that are not being changed.
 *
 * Every control has to preserve the others, or changing the sort would silently
 * reset the filter and show a different set of cards than the one just chosen.
 * Page is deliberately dropped: after re-sorting or re-filtering, page 30 is
 * a different 100 holdings, and landing there is disorienting.
 */
export function collectionHref(params: {
  sort?: SortId;
  filter?: FilterId;
  page?: number;
  search?: string;
}): string {
  const query = new URLSearchParams();
  if (params.sort && params.sort !== DEFAULT_SORT) query.set("sort", params.sort);
  if (params.filter && params.filter !== DEFAULT_FILTER) {
    query.set("filter", params.filter);
  }
  if (params.search) query.set("q", params.search);
  if (params.page && params.page > 1) query.set("page", String(params.page));

  const string = query.toString();
  return string ? `/?${string}` : "/";
}
