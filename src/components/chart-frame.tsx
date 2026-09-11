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
 * `children` receives both the measured width — so the caller can size its own
 * downsampling to it, making an expanded chart show more of the data rather
 * than the same points stretched wider — and the height class its plot element
 * must carry.
 *
 * That second argument is not a convenience. A chart's plot area sits inside a
 * `<figure>` alongside a legend and a table, and the height cannot live on a
 * wrapper around all of that: `h-full` inside an auto-height figure resolves to
 * zero, Recharts' ResponsiveContainer measures zero, and the chart renders
 * blank with nothing in the console. The height has to land on the plot element
 * itself, which only the caller can place.
 */
export function ChartFrame({
  children,
  label,
  height = "h-64 sm:h-72",
}: {
  children: (args: { width: number; plotClass: string }) => React.ReactNode;
  /** Describes the chart for the expand button's accessible name. */
  label: string;
  /** Height classes for the plot area when not expanded. */
  height?: string;
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
      if (!document.fullscreenElement) setExpanded(overlay);
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
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
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

  // Tall enough to be worth expanding into, with room left for the legend and
  // the button above it.
  const plotClass = expanded ? "h-[calc(100vh-12rem)]" : height;

  return (
    <div
      ref={ref}
      className={
        overlay
          ? "fixed inset-0 z-50 overflow-auto bg-white p-6 dark:bg-neutral-950"
          : "relative w-full"
      }
    >
      <button
        type="button"
        onClick={toggle}
        aria-pressed={expanded}
        className="absolute top-0 right-0 z-10 rounded-md border border-neutral-300 bg-white/80 px-2 py-1 text-xs text-neutral-600 backdrop-blur transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950/80 dark:text-neutral-400 dark:hover:bg-neutral-900"
      >
        {expanded ? "Exit full screen" : "Expand"}
        <span className="sr-only"> {label}</span>
      </button>

      {/* Keyed on the expanded state so Recharts remounts at the new size
          rather than animating from the old one. */}
      <div key={expanded ? "expanded" : "normal"}>
        {children({ width, plotClass })}
      </div>
    </div>
  );
}
