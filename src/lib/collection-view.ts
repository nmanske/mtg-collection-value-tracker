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
  { id: "value", label: "Value", description: "line value", first: "desc" },
  { id: "unit", label: "Unit", description: "unit price", first: "desc" },
  { id: "name", label: "Name", description: "card name", first: "asc" },
  { id: "acquired", label: "Acquired", description: "acquisition date", first: "desc" },
  { id: "quantity", label: "Copies", description: "copies held", first: "desc" },
  { id: "set", label: "Set", description: "set, then collector number", first: "asc" },
  { id: "finish", label: "Finish", description: "finish", first: "asc" },
  { id: "condition", label: "Cond", description: "condition", first: "asc" },
] as const;

export type SortId = (typeof SORTS)[number]["id"];
export const DEFAULT_SORT: SortId = "acquired";

export type SortDir = "asc" | "desc";

/**
 * Which way a column sorts when it is first clicked.
 *
 * Money and counts open largest-first because "what are my best cards" is the
 * question being asked; names and dates open in their natural reading order.
 * Clicking the same column again reverses it.
 */
export function defaultDir(sort: SortId): SortDir {
  return SORTS.find((s) => s.id === sort)!.first as SortDir;
}

export function isSortDir(value: string): value is SortDir {
  return value === "asc" || value === "desc";
}

export function resolveDir(
  value: string | undefined,
  sort: SortId,
): SortDir {
  return value && isSortDir(value) ? value : defaultDir(sort);
}

/** The direction a header link should request: flip if already active. */
export function nextDir(
  column: SortId,
  activeSort: SortId,
  activeDir: SortDir,
): SortDir {
  if (column !== activeSort) return defaultDir(column);
  return activeDir === "asc" ? "desc" : "asc";
}

/**
 * Narrowings worth offering, as opposed to every column being filterable.
 *
 * Finish, because it is the one property of a holding that is not visible from
 * the card name and changes what a printing is worth.
 *
 * "Unpriced" and "Inferred date" were here and are gone. Unpriced matched
 * nothing on a real collection — the importer only keeps rows it can identify,
 * and the dashboard already banners the count if it is ever non-zero. Inferred
 * date matched most of the collection, because Moxfield's export makes almost
 * every date a floor, so it narrowed nothing and only invited the question it
 * could not answer in a button label. /faq explains it instead.
 */
export const FILTERS = [
  { id: "all", label: "All", description: "every holding" },
  { id: "nonfoil", label: "Non-foil", description: "non-foil printings" },
  { id: "foil", label: "Foil", description: "foil printings" },
  { id: "etched", label: "Etched", description: "etched foil printings" },
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
  dir?: SortDir;
  filter?: FilterId;
  page?: number;
  search?: string;
}): string {
  const query = new URLSearchParams();
  if (params.sort && params.sort !== DEFAULT_SORT) query.set("sort", params.sort);
  // Omitted when it is the column's own default, so the common links stay
  // short and a shared URL does not pin a direction the reader never chose.
  if (params.sort && params.dir && params.dir !== defaultDir(params.sort)) {
    query.set("dir", params.dir);
  }
  if (params.filter && params.filter !== DEFAULT_FILTER) {
    query.set("filter", params.filter);
  }
  if (params.search) query.set("q", params.search);
  if (params.page && params.page > 1) query.set("page", String(params.page));

  const string = query.toString();
  return string ? `/?${string}` : "/";
}
