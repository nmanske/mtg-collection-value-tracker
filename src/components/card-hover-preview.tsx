"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Shows a card's art next to the cursor while a row is hovered.
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
 */

/** Scryfall `normal` art is 488x680. */
const WIDTH = 240;
const HEIGHT = Math.round((WIDTH * 680) / 488);
/** Clear of the pointer, so the preview never sits under the cursor itself. */
const OFFSET = 18;
/** Never flush against a window edge. */
const MARGIN = 8;

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

export function CardHoverPreview({
  src,
  alt,
  children,
  className,
}: {
  src: string | null;
  alt: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // Resolved on first use rather than in an effect: a tap on a touchscreen
  // fires mouseenter, which would leave a preview stuck over the page with no
  // pointer to move it away.
  const hoverable = useRef<boolean | null>(null);

  // A preview anchored to the pointer goes stale the moment the page moves
  // under it, and a wheel over the list is the common way to reach the rest
  // of it.
  useEffect(() => {
    if (!at) return;
    const clear = () => setAt(null);
    window.addEventListener("scroll", clear, { passive: true });
    return () => window.removeEventListener("scroll", clear);
  }, [at]);

  const track = (event: React.MouseEvent) => {
    if (!src) return;
    hoverable.current ??= window.matchMedia("(hover: hover)").matches;
    if (!hoverable.current) return;
    setAt(place(event.clientX, event.clientY));
  };

  return (
    <>
      <span
        className={className}
        onMouseEnter={track}
        onMouseMove={track}
        onMouseLeave={() => setAt(null)}
      >
        {children}
      </span>
      {at && src
        ? createPortal(
            // Plain <img> as everywhere else here: remote Scryfall URLs in a
            // local single-user tool.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={alt}
              width={WIDTH}
              height={HEIGHT}
              className="pointer-events-none fixed z-50 rounded-xl shadow-2xl ring-1 ring-black/10"
              style={{ left: at.left, top: at.top, width: WIDTH }}
            />,
            document.body,
          )
        : null}
    </>
  );
}
