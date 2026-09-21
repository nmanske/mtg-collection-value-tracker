import { clearCollectionAction } from "@/app/actions/collection";
import type { CollectionSession } from "@/db/schema";

/**
 * Says whose collection is on screen, and how to make it go away.
 *
 * An uploaded collection is a strange kind of state: there is no account, no
 * name, nothing to log out of, and the only evidence it exists is that the
 * numbers on the page are yours. Saying so out loud, above the numbers, is
 * what makes that legible rather than uncanny — and it puts the button that
 * deletes it where somebody looking for it would look.
 */
export function SessionBanner({ session }: { session: CollectionSession }) {
  const unmatched = session.unmatched;

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/60">
      <div className="min-w-0 text-sm">
        <span className="font-medium">{session.label}</span>{" "}
        <span className="text-neutral-600 dark:text-neutral-400">
          · {session.matched.toLocaleString()} holding
          {session.matched === 1 ? "" : "s"}
          {unmatched > 0
            ? ` · ${unmatched.toLocaleString()} line${unmatched === 1 ? "" : "s"} not matched`
            : ""}
        </span>
        <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
          Held for this browser only, and deleted after two days idle.
        </p>
      </div>

      <form action={clearCollectionAction}>
        <button
          type="submit"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Forget this collection
        </button>
      </form>
    </div>
  );
}

/**
 * When pricing a collection failed.
 *
 * It says what went wrong and offers the only two things that help: try again,
 * or let go of it. A page that just spins is the alternative, and spinning
 * forever is how a reader finds out something is broken far too late.
 */
export function SessionFailed({ session }: { session: CollectionSession }) {
  return (
    <main className="page-shell py-16">
      <div className="mx-auto max-w-lg">
        <h1 className="text-xl font-medium">
          Could not price {session.label}
        </h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          The cards were read — {session.matched.toLocaleString()} holding
          {session.matched === 1 ? "" : "s"} — but working out what they were
          worth over time did not finish.
        </p>
        {session.warmError ? (
          <p className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300">
            {session.warmError}
          </p>
        ) : null}
        <form action={clearCollectionAction} className="mt-6">
          <button
            type="submit"
            className="rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Start again
          </button>
        </form>
      </div>
    </main>
  );
}
