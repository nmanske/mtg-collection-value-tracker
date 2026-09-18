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
  alt,
  className,
}: {
  src: string;
  /** Full-size URL. Falls back to `src` when the column is not yet populated. */
  largeSrc?: string | null;
  alt: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
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
    <>
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={`block shrink-0 cursor-zoom-in rounded transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 ${className ?? ""}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="h-full w-full rounded object-contain"
        />
        <span className="sr-only">View larger</span>
      </button>

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
            src={largeSrc ?? src}
            alt={alt}
            // Stops a click on the card itself from closing, while a click on
            // the backdrop still does — the behaviour people expect of a
            // lightbox, and easy to get backwards.
            onClick={(event) => event.stopPropagation()}
            className="max-h-full max-w-full rounded-xl shadow-2xl"
          />

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
    </>
  );
}
