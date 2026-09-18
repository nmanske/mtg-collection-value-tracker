"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A card image that opens full size when clicked.
 *
 * Card art is the fastest way to recognise a printing, and at 80-160px wide it
 * is too small to read a name, let alone tell two arts of the same card apart.
 *
 * `large` is preferred and `normal` is the fallback, because `image_uri_large`
 * is null until the next metadata ingest populates it. Zooming a `normal` image
 * still helps — 488px shown at 488px beats 80px — so the feature works before
 * the backfill rather than appearing broken.
 *
 * Plain `<img>` throughout, as elsewhere in this app: these are remote Scryfall
 * URLs and this is a local single-user tool, so next/image would add a
 * remote-pattern config and a proxy hop for nothing.
 */
export function CardImage({
  src,
  largeSrc,
  backSrc,
  backLargeSrc,
  alt,
  className,
}: {
  src: string;
  /** Full-size URL. Falls back to `src` when the column is not yet populated. */
  largeSrc?: string | null;
  /** Reverse of a double-faced card. Absent for a single-faced one. */
  backSrc?: string | null;
  backLargeSrc?: string | null;
  alt: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [flipped, setFlipped] = useState(false);

  const hasBack = Boolean(backSrc);
  const face = flipped && backSrc ? backSrc : src;
  const faceLarge =
    (flipped ? (backLargeSrc ?? backSrc) : largeSrc) ?? face;
  const faceAlt = flipped ? `${alt}, reverse` : alt;
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and the page behind does not scroll while it is open —
  // otherwise a wheel over the backdrop scrolls the list underneath, which
  // reads as the overlay being broken rather than modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Focus moves into the overlay on open and back to the image on close, so a
  // keyboard user is not dropped at the top of the document.
  useEffect(() => {
    if (open) closeRef.current?.focus();
    else openerRef.current?.focus();
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <div className={className ? "shrink-0" : undefined}>
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={`block shrink-0 cursor-zoom-in rounded transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 ${className ?? ""}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={face}
          alt={faceAlt}
          loading="lazy"
          className="h-full w-full rounded object-contain"
        />
        <span className="sr-only">View larger</span>
      </button>

      {/* Only for cards that genuinely have a second face. A split or adventure
          card also has two `card_faces` but one picture, and the ingest keeps
          `image_uri_back` null for those so no button appears. */}
      {hasBack ? (
        <button
          type="button"
          onClick={() => setFlipped((was) => !was)}
          aria-pressed={flipped}
          className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-xs transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Flip
        </button>
      ) : null}

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${alt}, full size`}
          onClick={close}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={faceLarge}
            alt={faceAlt}
            // Stops a click on the card itself from closing, while a click on
            // the backdrop still does — the behaviour people expect of a
            // lightbox, and easy to get backwards.
            onClick={(event) => event.stopPropagation()}
            className="max-h-full max-w-full rounded-xl shadow-2xl"
          />

          {hasBack ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setFlipped((was) => !was);
              }}
              aria-pressed={flipped}
              className="absolute top-4 left-4 rounded-md border border-white/30 bg-black/40 px-3 py-1.5 text-sm text-white backdrop-blur transition-colors hover:bg-black/60"
            >
              Flip
            </button>
          ) : null}

          <button
            ref={closeRef}
            type="button"
            onClick={close}
            className="absolute top-4 right-4 rounded-md border border-white/30 bg-black/40 px-3 py-1.5 text-sm text-white backdrop-blur transition-colors hover:bg-black/60"
          >
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
