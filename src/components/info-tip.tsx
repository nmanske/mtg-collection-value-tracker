/**
 * A small "why?" disclosure.
 *
 * The pages used to explain themselves in paragraphs of grey text sitting
 * permanently under every figure. The explanations were accurate and worth
 * having; reading them every visit was not. They move in here, where they cost
 * one glyph until someone wants them.
 *
 * Built on `<details>` rather than a floating popover: no JavaScript, keyboard
 * and screen-reader support for free, and it cannot open off the edge of a
 * phone. Everything on this site works without client JS and this is no
 * exception.
 *
 * Keep the contents to a sentence or two. Anything longer belongs on /faq.
 *
 * `details` is flow content, so it must not be placed inside a `<p>` or an
 * `<h2>` — both take phrasing content only, and the parser would close them
 * early and desync hydration. Put it in a `<div>` beside the text instead.
 */
export function InfoTip({
  label,
  children,
}: {
  /** What the tip explains, for screen readers: "Why prices differ". */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group inline">
      <summary
        aria-label={label}
        title={label}
        className="ml-1 inline-flex h-4 w-4 cursor-pointer list-none items-center justify-center rounded-full border border-neutral-400 text-[10px] font-medium leading-none text-neutral-600 dark:text-neutral-400 transition-colors marker:hidden hover:border-neutral-600 hover:text-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-neutral-400 dark:hover:text-neutral-200"
      >
        {/* The marker is removed two ways: Chrome and Firefox honour
            list-style, Safari only honours the pseudo-element. */}
        <span className="pointer-events-none select-none">i</span>
      </summary>
      {/* A block inside an inline `details` breaks the inline box, so the
          panel spans the full width of the nearest block rather than being
          indented to wherever the marker happened to sit. `font-normal` resets
          the weight when the tip sits beside a heading. */}
      <div className="mt-2 max-w-prose rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs font-normal leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-400">
        {children}
      </div>
    </details>
  );
}
