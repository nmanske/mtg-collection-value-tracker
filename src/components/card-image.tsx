"use client";

import { useState } from "react";

/**
 * A card image, with a flip control for double-faced cards.
 *
 * `large` is preferred and `normal` is the fallback, because `image_uri_large`
 * is null until the next metadata ingest populates it.
 *
 * Plain `<img>` throughout, as elsewhere in this app: these are remote Scryfall
 * URLs and this is a local single-user tool, so next/image would add a
 * remote-pattern config and a proxy hop for nothing.
 *
 * It used to open full size on click. The images are large enough by default
 * now that the overlay was a modal, a focus trap and a scroll lock in exchange
 * for nothing.
 */
export function CardImage({
  src,
  backSrc,
  alt,
  className,
  foil = false,
}: {
  src: string;
  /** Reverse of a double-faced card. Absent for a single-faced one. */
  backSrc?: string | null;
  alt: string;
  className?: string;
  /** Give the art a foil sheen. */
  foil?: boolean;
}) {
  const [flipped, setFlipped] = useState(false);

  const hasBack = Boolean(backSrc);
  const face = flipped && backSrc ? backSrc : src;
  const faceAlt = flipped ? `${alt}, reverse` : alt;

  return (
    <div className={className ? "shrink-0" : undefined}>
      <div className={`relative overflow-hidden rounded ${className ?? ""} ${foil ? "foil" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={face}
          alt={faceAlt}
          loading="lazy"
          className="h-full w-full rounded object-contain"
        />
      </div>

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
    </div>
  );
}
