import { Fragment } from "react";
import Link from "next/link";

import { db } from "@/db";
import { PortfolioSummaryPanel } from "@/components/portfolio-summary";
import { VendorTotals } from "@/components/vendor-totals";
import { listHoldings } from "@/db/queries/holdings";
import { CollectionControls } from "@/components/collection-controls";
import {
  CardHoverPreview,
  NAMED_CARD_PREVIEW,
} from "@/components/card-hover-preview";
import { LandingPage } from "@/components/landing-page";
import { SessionBanner, SessionFailed } from "@/components/session-banner";
import { SessionWarming } from "@/components/session-warming";
import { requestSessionWarm } from "@/lib/session-warm";
import { activeCollection } from "@/lib/session";
import { PrivacyToggle } from "@/components/privacy-toggle";
import { ownerImportEnabled, privacyConfig } from "@/lib/privacy";
import {
  collectionHref,
  nextDir,
  resolveDir,
  resolveFilter,
  resolveSort,
  type SortId,
} from "@/lib/collection-view";
import {
  portfolioSummary,
  PRICE_VENDORS,
  type PriceVendor,
} from "@/db/queries/valuation";
import { collectionByVendor } from "@/db/queries/vendors";
import { cachedPortfolioSeries } from "@/db/queries/portfolio-cache";
import { priceFreshness } from "@/db/queries/freshness";
import { PriceFreshnessBanner } from "@/components/price-freshness-banner";
import {
  FINISH_LABEL,
  daysAgo,
  formatUsd,
  printingCode,
} from "@/lib/format";

// Reads the collection on every request; adds and removes must show at once.
export const dynamic = "force-dynamic";

/**
 * A column heading that sorts.
 *
 * A link rather than a button, so the sorted view has a URL that survives a
 * reload and a share, and so the table still sorts with JavaScript off. The
 * arrow is the only indicator, and it is paired with `aria-sort` rather than
 * left to colour or position.
 */
function SortHeader({
  column,
  label,
  align,
  sort,
  dir,
  filter,
  search,
}: {
  column: SortId;
  label: string;
  align?: "right";
  sort: SortId;
  dir: "asc" | "desc";
  filter: ReturnType<typeof resolveFilter>;
  search: string;
}) {
  const active = column === sort;
  const target = nextDir(column, sort, dir);

  return (
    <th
      scope="col"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`py-2 pr-3 font-medium ${align === "right" ? "text-right" : ""}`}
    >
      <Link
        href={collectionHref({ sort: column, dir: target, filter, search })}
        scroll={false}
        className="inline-flex items-center gap-1 hover:text-neutral-700 dark:hover:text-neutral-200"
      >
        {label}
        <span aria-hidden className={active ? "" : "opacity-0"}>
          {dir === "asc" ? "↑" : "↓"}
        </span>
      </Link>
    </th>
  );
}

export default async function CollectionPage(props: PageProps<"/">) {
  // Which collection this browser is looking at: an uploaded one, the host's
  // own, or none at all. `present` is what decides between the dashboard and
  // the front door — a public instance has no host collection, so a visitor
  // who has not uploaded anything gets the front door rather than a page of
  // zeroes.
  const { scope, session, present } = await activeCollection();
  if (!present) return <LandingPage />;

  // An uploaded collection is priced by a child process, so it may not be
  // ready yet. Asking again on every poll is deliberate: `requestSessionWarm`
  // declines when the box is already running as many workers as it will, and
  // this is what picks that session up once a slot frees.
  if (session && session.warmState !== "ready") {
    if (session.warmState === "failed") return <SessionFailed session={session} />;
    requestSessionWarm(session.id);
    return (
      <SessionWarming
        label={session.label}
        holdings={session.matched}
        percent={session.warmProgress}
        step={session.warmStep}
        detail={session.warmDetail}
      />
    );
  }

  // searchParams is a Promise in Next 16.
  const { page, range, prices, sort, dir, filter, q } = await props.searchParams;
  const priceSource: PriceVendor =
    typeof prices === "string" && (PRICE_VENDORS as readonly string[]).includes(prices)
      ? (prices as PriceVendor)
      : "tcgplayer";
  const activeSort = resolveSort(typeof sort === "string" ? sort : undefined);
  const activeDir = resolveDir(typeof dir === "string" ? dir : undefined, activeSort);
  const activeFilter = resolveFilter(
    typeof filter === "string" ? filter : undefined,
  );
  const search = typeof q === "string" ? q : "";

  const {
    rows,
    totalCards,
    unpricedCount,
    holdingCount,
    pageCount,
    page: current,
    matched,
  } = listHoldings(db, {
    page: Number(page) || 1,
    sort: activeSort,
    dir: activeDir,
    filter: activeFilter,
    search,
    // The table follows the vendor toggle, as the chart above it does.
    vendor: priceSource,
    buylist: priceSource === "cardkingdom",
    scope,
  });
  const showBuylist = priceSource === "cardkingdom";
  // A pasted list has no acquisition dates, so there is no honest as-held
  // series for one: the fixed basket is what gets drawn and labelled.
  const datesKnown = !session || session.source === "csv";
  const summary = portfolioSummary(db, priceSource, scope, datesKnown);
  // Card Kingdom is the only vendor here that publishes a buy price, so the
  // "if sold today" line exists on their view and nowhere else.
  const buylistPoints =
    priceSource === "cardkingdom"
      ? cachedPortfolioSeries(db, { buylist: true, scope }).points
      : undefined;
  const vendorTotals = collectionByVendor(db, scope);
  const freshness = priceFreshness(db);

  return (
    <main className="page-shell py-10">
      {/* Above the header: if prices have stopped arriving, that outranks
          every number on the page, because every number is derived from them. */}
      <PriceFreshnessBanner freshness={freshness} />

      {/* Whose collection this is, when it is not the host's own. */}
      {session ? <SessionBanner session={session} /> : null}

      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Collection</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {totalCards.toLocaleString()} card
            {totalCards === 1 ? "" : "s"} across{" "}
            {holdingCount.toLocaleString()} holding
            {holdingCount === 1 ? "" : "s"}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Quiet, because it is read once and then rarely. */}
          <Link
            href="/faq"
            className="px-1 text-sm text-neutral-600 dark:text-neutral-400 underline-offset-4 hover:underline"
          >
            How it works
          </Link>
          <PrivacyToggle password={privacyConfig().password} />
          <Link
            href="/search"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Search cards
          </Link>
          <Link
            href="/stats"
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Stats
          </Link>
          {/* Hidden values and a one-click CSV of every price do not belong
              on the same page. Driven by the same class as the blur, so it
              cannot disagree with it. */}
          <Link
            href="/export"
            className="hide-entirely rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Export
          </Link>
          {/* Only where that page exists to be linked to. */}
          {ownerImportEnabled() ? (
            <Link
              href="/import"
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Import CSV
            </Link>
          ) : null}
        </div>
      </header>

      <PortfolioSummaryPanel
        summary={summary}
        datesKnown={datesKnown}
        buylistPoints={buylistPoints}
        range={typeof range === "string" ? range : undefined}
        priceSource={priceSource}
        // The retail row for the selected vendor is what the chart is drawn
        // from, so its stale count is what explains the gap between the two.
        staleHoldings={
          vendorTotals.find(
            (row) => row.vendor === priceSource && row.side === "retail",
          )?.stale ?? 0
        }
      />

      <VendorTotals totals={vendorTotals} holdingCount={holdingCount} />

      {unpricedCount > 0 ? (
        // Never let an unpriced card quietly count as $0 in the total.
        <p className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {unpricedCount} unpriced holding{unpricedCount === 1 ? "" : "s"},
          excluded from the total.
        </p>
      ) : null}

      {holdingCount > 0 ? (
        <CollectionControls
          sort={activeSort}
          filter={activeFilter}
          search={search}
          matched={matched}
          total={holdingCount}
        />
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Nothing here yet.{" "}
            <Link href="/search" className="underline underline-offset-4">
              Search for a card
            </Link>
            {ownerImportEnabled() ? (
              <>
                {" "}
                or{" "}
                <Link href="/import" className="underline underline-offset-4">
                  import a Moxfield CSV
                </Link>
              </>
            ) : null}
            .
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-600 dark:text-neutral-400 dark:border-neutral-800">
                {(
                  [
                    ["name", "Card", undefined],
                    ["set", "Set", undefined],
                    ["finish", "Finish", undefined],
                    ["condition", "Cond", undefined],
                    ["quantity", "Qty", "right"],
                    ["unit", "Unit", "right"],
                    ["value", "Value", "right"],
                    ["acquired", "Acquired", undefined],
                  ] as const
                ).map(([column, label, align]) => (
                  <Fragment key={column}>
                    <SortHeader
                      column={column}
                      label={label}
                      align={align}
                      sort={activeSort}
                      dir={activeDir}
                      filter={activeFilter}
                      search={search}
                    />
                    {/* Beside Value, where it is compared, rather than at the
                        end of the row. Not sortable: there is no buylist
                        ordering in the query, and a header that looks
                        clickable and is not is worse than one that does not. */}
                    {showBuylist && column === "value" ? (
                      <th
                        scope="col"
                        className="py-2 pr-3 text-right font-medium"
                      >
                        CK pays
                      </th>
                    ) : null}
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const stale =
                  row.priceDate != null && daysAgo(row.priceDate) > 2;

                return (
                  <tr
                    key={row.id}
                    className="border-b border-neutral-100 dark:border-neutral-900"
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium">
                        <CardHoverPreview
                          src={row.imageUri}
                          alt={row.name}
                          foil={row.finish !== "nonfoil"}
                          {...NAMED_CARD_PREVIEW}
                        >
                          <Link
                            href={`/cards/${row.scryfallId}?finish=${row.finish}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {row.name}
                          </Link>
                        </CardHoverPreview>
                      </div>
                    </td>
                    {/* One line, and the same shape a card page uses: set,
                        number, year. Splitting the number onto a second row
                        made the cell two lines tall down the whole table to
                        save a few characters of width. */}
                    <td className="py-2 pr-3 whitespace-nowrap font-mono text-xs text-neutral-600 dark:text-neutral-400">
                      {printingCode(
                        row.setCode,
                        row.collectorNumber,
                        row.releasedAt,
                      )}
                    </td>
                    <td className="py-2 pr-3">{FINISH_LABEL[row.finish]}</td>
                    <td className="py-2 pr-3">{row.condition}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {row.quantity}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {row.unitPriceCents == null ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          no price
                        </span>
                      ) : (
                        <>
                          {formatUsd(row.unitPriceCents)}
                          {row.overridden ? (
                            <span
                              className="ml-1 text-xs text-neutral-600 dark:text-neutral-400"
                              title="Manual override"
                            >
                              (manual)
                            </span>
                          ) : stale && row.priceDate ? (
                            <span
                              className="ml-1 text-xs text-neutral-600 dark:text-neutral-400"
                              title={`Last priced ${row.priceDate}`}
                            >
                              ({daysAgo(row.priceDate)}d old)
                            </span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {row.unitPriceCents == null
                        ? "—"
                        : formatUsd(row.unitPriceCents * row.quantity)}
                    </td>
                    {/* Unit, not line: it sits beside the unit ask, and the
                        pair is what a reader compares. */}
                    {showBuylist ? (
                      <td className="py-2 pr-3 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                        {row.buylistCents == null
                          ? "—"
                          : formatUsd(row.buylistCents)}
                      </td>
                    ) : null}
                    <td className="py-2 pr-3 tabular-nums text-neutral-600 dark:text-neutral-400">
                      {row.dateAdded}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 ? (
        // The table is paged because rendering thousands of rows costs seconds
        // of server render time; the totals above always cover everything.
        <nav
          aria-label="Pagination"
          className="mt-6 flex items-center justify-between text-sm"
        >
          {current > 1 ? (
            <Link
              href={collectionHref({
                sort: activeSort,
                filter: activeFilter,
                search,
                page: current - 1,
              })}
              className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}

          <span className="text-neutral-600 dark:text-neutral-400">
            Page {current.toLocaleString()} of {pageCount.toLocaleString()}
          </span>

          {current < pageCount ? (
            <Link
              href={collectionHref({
                sort: activeSort,
                filter: activeFilter,
                search,
                page: current + 1,
              })}
              className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}
