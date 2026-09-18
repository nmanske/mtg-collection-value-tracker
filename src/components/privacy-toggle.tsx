"use client";

/**
 * Hides money on screen, for looking at this with someone behind you.
 *
 * A class on `<html>` rather than a URL parameter. The parameter would have to
 * be threaded through every link on every page — sort headers, filters, ranges,
 * vendor tabs, pagination — and forgetting one would un-hide the totals
 * mid-navigation, which is the one moment it must not.
 *
 * No React state. The button's label is driven by the same class through CSS,
 * so there is nothing to hydrate, no flicker of the wrong label on load, and
 * no state that can disagree with what is on screen.
 */

export const PRIVACY_KEY = "mtg:hide-money";
export const PRIVACY_CLASS = "hide-money";

export function PrivacyToggle() {
  return (
    <button
      type="button"
      onClick={(event) => {
        const root = document.documentElement;
        const next = !root.classList.contains(PRIVACY_CLASS);
        root.classList.toggle(PRIVACY_CLASS, next);
        event.currentTarget.setAttribute("aria-pressed", String(next));
        try {
          localStorage.setItem(PRIVACY_KEY, next ? "1" : "0");
        } catch {
          // Private browsing, or storage disabled. The toggle still works for
          // this page; it just will not be remembered.
        }
      }}
      aria-pressed="false"
      className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
    >
      <span className="when-showing">Hide values</span>
      <span className="when-hiding">Show values</span>
    </button>
  );
}

/**
 * Applies the stored preference before the first paint.
 *
 * Without this the page renders with the totals visible and hides them a frame
 * later, which defeats the point. Inlined in `<head>` and deliberately tiny.
 */
export function PrivacyScript() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `try{if(localStorage.getItem(${JSON.stringify(PRIVACY_KEY)})==="1"){document.documentElement.classList.add(${JSON.stringify(PRIVACY_CLASS)})}}catch(e){}`,
      }}
    />
  );
}
