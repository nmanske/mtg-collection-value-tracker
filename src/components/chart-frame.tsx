"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A resizable, full-screenable box for a chart.
 *
 * Charts were a fixed-height div at whatever width the page column happened to
 * be. That was fine for 89 points and is not for ~2,100: the useful detail in a
 * long series is bounded by how many pixels it is drawn across, so the chart
 * needs to be able to get bigger, and the series needs to know how big it got.
 *
 * The measured width is handed back through `children` so the caller can size
 * its own downsampling to it — expanding the chart genuinely shows more of the
 * data rather than the same points stretched wider.
 *
 * Full screen uses the Fullscreen API where it is available and falls back to a
 * fixed overlay, which also covers the case where the request is rejected (it
 * requires a user gesture, and browsers may refuse it anyway).
 */
export function ChartFrame({
  children,
  label,
  className = "h-64 sm:h-72",
}: {
  children: (width: number) => React.ReactNode;
  /** Describes the chart for the expand button's accessible name. */
  label: string;
  /** Height classes for the normal, un-expanded state. */
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [overlay, setOverlay] = useState(false);

  // Measured rather than assumed: the column width varies with the viewport,
  // and going full screen changes it by a factor of three or more.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  // Track the browser's own notion of full screen, so pressing Escape — which
  // never reaches our button — still returns the control to its real state.
  useEffect(() => {
    const onChange = () => {
      const isFull = document.fullscreenElement === ref.current;
      setExpanded(isFull || overlay);
      if (!isFull && !overlay) setExpanded(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [overlay]);

  // Escape closes the fallback overlay, which the Fullscreen API would have
  // handled for us.
  useEffect(() => {
    if (!overlay) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOverlay(false);
        setExpanded(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay]);

  const toggle = useCallback(async () => {
    const element = ref.current;
    if (!element) return;

    if (expanded) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setOverlay(false);
      setExpanded(false);
      return;
    }

    try {
      await element.requestFullscreen();
      setExpanded(true);
    } catch {
      // Rejected, or unsupported: an in-page overlay is the same experience
      // minus the chrome, and is better than a button that does nothing.
      setOverlay(true);
      setExpanded(true);
    }
  }, [expanded]);

  return (
    <div className="relative">
      <div
        ref={ref}
        className={
          overlay
            ? "fixed inset-0 z-50 bg-white p-6 dark:bg-neutral-950"
            : `${className} w-full bg-white dark:bg-neutral-950`
        }
      >
        {/* Keyed on the expanded state so Recharts remounts at the new size
            rather than animating from the old one. */}
        <div key={overlay ? "expanded" : "normal"} className="h-full w-full">
          {children(width)}
        </div>
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-pressed={expanded}
        className={`absolute top-0 right-0 rounded-md border border-neutral-300 bg-white/80 px-2 py-1 text-xs text-neutral-600 backdrop-blur transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950/80 dark:text-neutral-400 dark:hover:bg-neutral-900 ${
          overlay ? "z-[60] m-6" : ""
        }`}
      >
        {expanded ? "Exit full screen" : "Expand"}
        <span className="sr-only"> {label}</span>
      </button>
    </div>
  );
}
