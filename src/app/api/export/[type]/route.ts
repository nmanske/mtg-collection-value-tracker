import { db } from "@/db";
import { exportFilename } from "@/export/csv";
import { EXPORTS, isExportId } from "@/export/datasets";
import { currentScope } from "@/lib/session";

/**
 * Streams an export as CSV.
 *
 * A route handler rather than a Server Action because this is a download: the
 * browser should hit a URL and save the response, with no round trip through
 * React state. Streaming keeps the largest export — a third of a million rows —
 * off the heap; it is generated and sent a row at a time.
 */

// Always reflects the database as it is now; an export must never be a cached
// snapshot of an older collection.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  // params is a Promise in Next 16.
  context: { params: Promise<{ type: string }> },
) {
  const { type } = await context.params;

  if (!isExportId(type)) {
    return new Response(`Unknown export "${type}"`, { status: 404 });
  }

  const spec = EXPORTS[type];
  // Whatever collection this browser is looking at, and only that one.
  const rows = spec.stream(db, await currentScope());

  const encoder = new TextEncoder();
  const iterator = rows[Symbol.iterator]();

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      // One row per pull would be a syscall per row; batching keeps the
      // 331,000-row export from spending all its time in stream plumbing.
      const chunk: string[] = [];
      for (let i = 0; i < 500; i += 1) {
        const next = iterator.next();
        if (next.done) {
          if (chunk.length > 0) controller.enqueue(encoder.encode(chunk.join("")));
          controller.close();
          return;
        }
        chunk.push(next.value);
      }
      controller.enqueue(encoder.encode(chunk.join("")));
    },
    cancel() {
      // A cancelled download must not leave the SQLite statement open.
      iterator.return?.();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(type)}"`,
      // These are generated per request and are never revalidated.
      "Cache-Control": "no-store",
    },
  });
}
