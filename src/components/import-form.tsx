"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  importMoxfieldAction,
  type ImportActionResult,
} from "@/app/actions/import";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
    >
      {/* A real import rebuilds the value history before returning, which
          takes half a minute on a large collection. "Reading file..." made
          that look like a hang. */}
      {pending ? "Importing, this takes a moment..." : "Import"}
    </button>
  );
}

export function ImportForm() {
  const [state, formAction] = useActionState<ImportActionResult | null, FormData>(
    importMoxfieldAction,
    null,
  );
  const report = state?.report;

  return (
    <>
      <form action={formAction} className="flex flex-col gap-4">
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-2 file:text-sm file:font-medium dark:file:bg-neutral-800"
        />

        <label className="flex items-center gap-2 text-sm">
          {/* Defaults on: a preview is the safe first move, and it is what
              reveals how the Condition and Foil columns were mapped. */}
          <input type="checkbox" name="dryRun" defaultChecked />
          Preview only
        </label>

        <div>
          <SubmitButton />
        </div>
      </form>

      {state ? (
        <p
          role="status"
          className={`mt-4 text-sm ${
            state.ok
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
          }`}
        >
          {state.message}
        </p>
      ) : null}

      {report ? (
        <div className="mt-6 flex flex-col gap-6 text-sm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            <Stat label="Rows in file" value={report.dataRows} />
            <Stat label="Rows imported" value={report.importedRows} />
            <Stat label="Cards" value={report.importedCards} />
            <Stat label="Proxies skipped" value={report.proxyCardsSkipped} />
            <Stat label="Not imported" value={report.problems.length} />
          </dl>

          <Mapping
            title="Condition values"
            note="Excellent and Good sit between Moxfield's scale and ours — check these."
            rows={report.conditionsSeen.map((entry) => ({
              raw: entry.raw,
              mapped: entry.mappedTo ?? "unrecognised → NM",
              count: entry.count,
              warn: entry.mappedTo === null,
            }))}
          />

          <Mapping
            title="Proxy column"
            note="Proxies are not imported — they carry none of the real card's value."
            rows={report.proxyValuesSeen.map((entry) => ({
              raw: entry.raw,
              mapped: entry.treatedAsProxy ? "proxy → skipped" : "real card",
              count: entry.count,
              warn: entry.treatedAsProxy,
            }))}
          />

          <Mapping
            title="Foil values"
            note="An empty value means a normal, non-foil card."
            rows={report.finishesSeen.map((entry) => ({
              raw: entry.raw,
              mapped: entry.mappedTo ?? "unrecognised → row skipped",
              count: entry.count,
              warn: entry.mappedTo === null,
            }))}
          />

          {report.unknownSets.length > 0 ? (
            <section>
              <h2 className="font-medium text-amber-700 dark:text-amber-400">
                Sets with no paper printings
              </h2>
              <p className="mb-2 text-xs text-neutral-500">
                Digital-only sets price in tix, not dollars, so these rows were
                skipped.
              </p>
              <ul className="flex flex-col gap-1">
                {report.unknownSets.map((set) => (
                  <li key={set.setCode} className="flex gap-2 font-mono text-xs">
                    <span className="w-12 shrink-0 text-right tabular-nums text-neutral-500">
                      {set.rows}
                    </span>
                    <span>{set.setCode.toUpperCase()}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {report.resolvedByName.length > 0 ? (
            <Problems
              title={`Resolved by name (${report.resolvedByName.length})`}
              tone="amber"
              rows={report.resolvedByName}
            />
          ) : null}

          {report.problems.length > 0 ? (
            <Problems
              title={`Not imported (${report.problems.length})`}
              tone="red"
              rows={report.problems}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

function Mapping({
  title,
  note,
  rows,
}: {
  title: string;
  note: string;
  rows: { raw: string; mapped: string; count: number; warn: boolean }[];
}) {
  return (
    <section>
      <h2 className="font-medium">{title}</h2>
      <p className="mb-2 text-xs text-neutral-500">{note}</p>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.raw} className="flex gap-2 font-mono text-xs">
            <span className="w-12 shrink-0 text-right tabular-nums text-neutral-500">
              {row.count.toLocaleString()}
            </span>
            <span className="w-40 shrink-0 truncate">
              {row.raw === "" ? "(empty)" : row.raw}
            </span>
            <span
              className={
                row.warn ? "text-amber-600 dark:text-amber-400" : "text-neutral-500"
              }
            >
              → {row.mapped}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Problems({
  title,
  tone,
  rows,
}: {
  title: string;
  tone: "amber" | "red";
  rows: { line: number; reason: string }[];
}) {
  const color =
    tone === "amber"
      ? "text-amber-700 dark:text-amber-400"
      : "text-red-700 dark:text-red-400";
  return (
    <section>
      <h2 className={`font-medium ${color}`}>{title}</h2>
      <ul className="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto">
        {rows.map((row) => (
          <li key={row.line} className="text-xs">
            <span className="text-neutral-500">line {row.line}:</span>{" "}
            {row.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}
