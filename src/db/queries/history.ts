import { asc, eq } from "drizzle-orm";

import { VENDOR_CODES } from "@/db/codec";
import { portfolioMonthly } from "@/db/schema";
import {
  type Drawdown,
  type IndexPoint,
  type MonthLink,
  type PeriodChange,
  annualChanges,
  chainBackward,
  extremes,
  highWaterMark,
  maxDrawdown,
  monthlyChanges,
} from "@/lib/portfolio-history";

import { cachedPortfolioSeries } from "./portfolio-cache";
import type { Db } from "./printings";
import type { PriceVendor } from "./valuation";

/**
 * Long-horizon history for the stats page.
 *
 * Everything here reads the month links the cache rebuild already wrote. The
 * underlying work — every held printing's full price history — is a scan of a
 * 215 million row table, so computing it per request is not an option; when the
 * links are missing the page shows nothing rather than stalling for 24s.
 */

export interface PortfolioHistory {
  points: IndexPoint[];
  years: PeriodChange[];
  bestYear: PeriodChange | null;
  worstYear: PeriodChange | null;
  bestMonth: PeriodChange | null;
  worstMonth: PeriodChange | null;
  drawdown: Drawdown | null;
  high: ReturnType<typeof highWaterMark>;
  /**
   * Holdings compared in the earliest link, against the collection's size.
   *
   * Surfaced rather than hidden: it is the honest limit of the whole panel. The
   * oldest figures rest on the two thirds of today's cards that existed then.
   */
  earliestCompared: number;
  totalHoldings: number;
}

export function portfolioHistory(
  db: Db,
  vendor: PriceVendor = "tcgplayer",
): PortfolioHistory | null {
  const links = db
    .select()
    .from(portfolioMonthly)
    .where(eq(portfolioMonthly.priceSource, VENDOR_CODES[vendor]))
    .orderBy(asc(portfolioMonthly.month))
    .all() as MonthLink[];

  if (links.length < 2) return null;

  // The anchor is the basket's real value now, so the newest point agrees with
  // the dashboard rather than being the product of seventy chained ratios.
  const basket = cachedPortfolioSeries(db, {
    priceSource: vendor,
    constantBasket: true,
  });
  const latest = basket.points[basket.points.length - 1];
  if (!latest) return null;

  const points = chainBackward(links, {
    month: latest.date.slice(0, 7),
    date: latest.date,
    valueCents: latest.valueCents,
  });

  const years = annualChanges(points);
  const yearExtremes = extremes(years);
  const monthExtremes = extremes(monthlyChanges(points));

  return {
    points,
    years,
    bestYear: yearExtremes.best,
    worstYear: yearExtremes.worst,
    bestMonth: monthExtremes.best,
    worstMonth: monthExtremes.worst,
    drawdown: maxDrawdown(points),
    high: highWaterMark(points),
    earliestCompared: links[0].compared,
    totalHoldings: latest.holdingsHeld,
  };
}
