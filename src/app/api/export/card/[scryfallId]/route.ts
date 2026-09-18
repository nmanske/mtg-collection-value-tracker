import { db } from "@/db";
import { getPrintingByScryfallId, priceHistory } from "@/db/queries/printings";
import { FINISHES, type Finish } from "@/db/schema";
import { csvRow, moneyCell, UTF8_BOM } from "@/export/csv";

/**
 * One printing's price history as CSV.
 *
 * Deliberately narrow, and worth saying why given the export page states there
 * is no per-card daily price export. That rule is about redistribution: a file
 * with one row per card per day, across every card, is a repackaged copy of a
 * provider's dataset and their terms forbid it. One card you already hold,
 * downloaded one card at a time, is not that — it is the chart on screen in a
 * form a spreadsheet can read.
 *
 * Reads along the price table's primary key, so it is a range scan over one
 * card rather than anything that touches the wider table.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  // params is a Promise in Next 16.
  context: { params: Promise<{ scryfallId: string }> },
) {
  const { scryfallId } = await context.params;
  const requested = new URL(request.url).searchParams.get("finish");
  const finish: Finish =
    requested && (FINISHES as readonly string[]).includes(requested)
      ? (requested as Finish)
      : "nonfoil";

  const printing = getPrintingByScryfallId(db, scryfallId);
  if (!printing) {
    return new Response("Unknown card", { status: 404 });
  }

  const points = priceHistory(db, printing.id, finish);

  const lines = [
    UTF8_BOM + csvRow(["date", "price_usd", "estimated"]),
    ...points.map((point) =>
      csvRow([point.date, moneyCell(point.priceCents), point.estimated ? "yes" : "no"]),
    ),
  ];

  // Small enough to build in memory: one card over six years is ~2,000 rows,
  // where the collection exports stream because they can be six figures.
  const slug = `${printing.setCode}-${printing.collectorNumber}-${finish}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");

  return new Response(lines.join(""), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="price-history-${slug}.csv"`,
      "cache-control": "no-store",
    },
  });
}
