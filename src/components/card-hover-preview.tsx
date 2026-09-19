"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Shows a card's art while a card is hovered.
 *
 * A list of other printings is a list of set names, and the art is what
 * actually distinguishes them — an alternate-art reprint is a different card
 * to look at and an identical line of text.
 *
 * Rendered through a portal into `<body>`, fixed-positioned, and clamped to
 * the viewport. A preview positioned inside the list would be clipped by any
 * ancestor with `overflow` set, and one placed blindly at the cursor runs off
 * the bottom of the window on the last row, which is exactly the row a reader
 * is most likely to be on when they reach the end of a long list.
 *
 * Two behaviours, because the two uses want different things. Scanning a list
 * of printings, the preview tracks the pointer and appears at once: the whole
 * point is to sweep the list. A card name in running text is passed over
 * constantly on the way to something else, so there it waits out a short
 * hover and then sits beside the name, where it does not move under a pointer
 * that is on its way somewhere.
 */

/**
 * The settings for a card name in running text, spread at every such site so
 * they cannot drift apart between pages.
 *
 * Half a second: long enough that a pointer crossing a name on its way
 * somewhere else never triggers it, short enough that deliberately resting on
 * a name does not feel like waiting.
 */
export const NAMED_CARD_PREVIEW = { delayMs: 500, follow: false } as const;

/** Scryfall `normal` art is 488x680. */
const WIDTH = 240;
const HEIGHT = Math.round((WIDTH * 680) / 488);
/** Clear of the pointer, so the preview never sits under the cursor itself. */
const OFFSET = 18;
/** Never flush against a window edge. */
const MARGIN = 8;

/** Where a preview goes for a cursor, or for an element's box. */
function place(x: number, y: number) {
  const { innerWidth, innerHeight } = window;
  // Right of the cursor by default; flipped to the left when that would
  // overflow, rather than clamped, so the cursor is never covered.
  let left = x + OFFSET;
  if (left + WIDTH + MARGIN > innerWidth) left = x - OFFSET - WIDTH;
  // Vertically the preview is clamped instead: flipping it above the cursor
  // makes it jump as the pointer crosses the midpoint of the screen.
  let top = y - HEIGHT / 2;
  top = Math.min(top, innerHeight - HEIGHT - MARGIN);
  return {
    left: Math.max(MARGIN, left),
    top: Math.max(MARGIN, top),
  };
}

/**
 * Anchored to an element rather than the pointer: beside it, level with it.
 *
 * `place` does the clamping, so the rules are identical — the only difference
 * is what the preview is measured from.
 */
function placeBeside(rect: DOMRect) {
  const from = place(rect.right, rect.top + rect.height / 2);
  // `place` offsets from a point; against a box the gap should start at the
  // edge, and flipping left has to clear the whole name rather than its end.
  return from.left > rect.right
    ? from
    : { ...from, left: Math.max(MARGIN, rect.left - OFFSET - WIDTH) };
}

export function CardHoverPreview({
  src,
  alt,
  children,
  className,
  /** Hover this long before the preview appears. 0 shows it immediately. */
  delayMs = 0,
  /** Track the pointer. Off means anchored to the element. */
  follow = true,
  /** Give the preview a foil sheen. */
  foil = false,
}: {
  src: string | null;
  alt: string;
  children: React.ReactNode;
  className?: string;
  delayMs?: number;
  follow?: boolean;
  foil?: boolean;
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // Resolved on first use rather than in an effect: a tap on a touchscreen
  // fires mouseenter, which would leave a preview stuck over the page with no
  // pointer to move it away.
  const hoverable = useRef<boolean | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // A timer outliving the element would show a preview for a card that is no
  // longer on screen.
  useEffect(() => cancel, []);

  // A preview goes stale the moment the page moves under it, and a wheel over
  // a list is the common way to reach the rest of it.
  useEffect(() => {
    if (!at) return;
    const clear = () => {
      cancel();
      setAt(null);
    };
    window.addEventListener("scroll", clear, { passive: true });
    return () => window.removeEventListener("scroll", clear);
  }, [at]);

  const track = (event: React.MouseEvent) => {
    if (!src) return;
    hoverable.current ??= window.matchMedia("(hover: hover)").matches;
    if (!hoverable.current) return;

    if (!follow) {
      // Already showing: a move within the name must not re-arm the timer and
      // make the preview flicker.
      if (at || timer.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      timer.current = setTimeout(() => {
        timer.current = null;
        setAt(placeBeside(rect));
      }, delayMs);
      return;
    }

    setAt(place(event.clientX, event.clientY));
  };

  const leave = () => {
    cancel();
    setAt(null);
  };

  return (
    <>
      <span
        className={className}
        onMouseEnter={track}
        onMouseMove={track}
        onMouseLeave={leave}
      >
        {children}
      </span>
      {at && src
        ? createPortal(
            // Plain <img> as everywhere else here: remote Scryfall URLs in a
            // local single-user tool.
            <span
              className={`pointer-events-none fixed z-50 block rounded-xl shadow-2xl ring-1 ring-black/10 ${
                foil ? "foil" : ""
              }`}
              style={{ left: at.left, top: at.top, width: WIDTH }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={alt}
                width={WIDTH}
                height={HEIGHT}
                className="block w-full rounded-xl"
              />
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
