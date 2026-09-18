import Link from "next/link";

import {
  collectionHref,
  FILTERS,
  type FilterId,
  type SortId,
} from "@/lib/collection-view";

/**
 * Filter and search for the collection list.
 *
 * Sorting lives on the table's column headers, where a reader looks for it.
 * A duplicate row of sort chips here was the same control twice.
 *
 * Links rather than a form, so every view has a URL that can be bookmarked,
 * shared or reloaded — and so the whole thing works without JavaScript, which
 * matters for a page that is otherwise a server-rendered table.
 *
 * Search is the exception and is a real form: a text box cannot be a set of
 * links. It keeps the other controls as hidden fields, because losing the sort
 * on every search would be its own kind of broken.
 */
function Chip({
  href,
  active,
  children,
  title,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      title={title}
      aria-current={active ? "true" : undefined}
      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
          : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      }`}
    >
      {children}
    </Link>
  );
}

export function CollectionControls({
  sort,
  filter,
  search,
  matched,
  total,
}: {
  sort: SortId;
  filter: FilterId;
  search: string;
  matched: number;
  total: number;
}) {
  const narrowed = matched !== total;

  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label="Filter collection" className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-neutral-600 dark:text-neutral-400">Show</span>
          {FILTERS.map((option) => (
            <Chip
              key={option.id}
              href={collectionHref({ sort, filter: option.id, search })}
              active={option.id === filter}
              title={option.description}
            >
              {option.label}
            </Chip>
          ))}
        </nav>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <form action="/" className="flex items-center gap-2">
          {/* The other controls travel with the search, or searching would
              silently reset them. */}
          <input type="hidden" name="sort" value={sort} />
          <input type="hidden" name="filter" value={filter} />
          <label htmlFor="collection-search" className="text-xs text-neutral-600 dark:text-neutral-400">
            Find
          </label>
          <input
            id="collection-search"
            name="q"
            type="search"
            defaultValue={search}
            placeholder="card or set"
            className="w-48 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Search
          </button>
        </form>

        {narrowed ? (
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {matched.toLocaleString()} of {total.toLocaleString()} holdings
            {search ? ` matching “${search}”` : ""}.{" "}
            {/* The totals above deliberately still describe the whole
                collection, so say so rather than letting the two figures look
                like a contradiction. */}
            <span className="text-neutral-400">
              Totals above cover the whole collection.
            </span>{" "}
            <Link href={collectionHref({ sort })} className="underline">
              Clear
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}
