"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hides money on screen, for looking at this with someone behind you.
 *
 * A class on `<html>` rather than a URL parameter. The parameter would have to
 * be threaded through every link on every page — sort headers, filters, ranges,
 * vendor tabs, pagination — and forgetting one would un-hide the totals
 * mid-navigation, which is the one moment it must not.
 *
 * Hidden by default: a browser that has never been told otherwise shows
 * nothing, which is the whole point on a shared network. Revealing takes a
 * password; hiding again does not.
 *
 * TEMPORARY. The password below is in the client bundle and the figures are
 * in the HTML either way — the blur is CSS. This stops someone reading the
 * screen, not someone reading the page source, and is not a security control.
 */

export const PRIVACY_KEY = "mtg:hide-money";
export const PRIVACY_CLASS = "hide-money";

/** What the reveal prompt accepts. See the warning above. */
const PRIVACY_PASSWORD = "pass";

function setHidden(hidden: boolean, button?: HTMLButtonElement | null) {
  document.documentElement.classList.toggle(PRIVACY_CLASS, hidden);
  // The label comes from CSS, but the pressed state is an attribute and has
  // to be kept in step by hand — on both paths, not just the hiding one.
  button?.setAttribute("aria-pressed", String(hidden));
  try {
    localStorage.setItem(PRIVACY_KEY, hidden ? "1" : "0");
  } catch {
    // Private browsing, or storage disabled. The toggle still works for this
    // page; it just will not be remembered.
  }
}

export function PrivacyToggle() {
  // Whether the password field is open, not whether values are hidden — that
  // stays on the class, so the label needs no hydration and cannot flicker.
  const [asking, setAsking] = useState(false);
  const [wrong, setWrong] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asking) inputRef.current?.focus();
  }, [asking]);

  return (
    <span className="relative inline-flex items-center gap-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          const hiding = document.documentElement.classList.contains(
            PRIVACY_CLASS,
          );
          // Hiding is free. Only revealing is gated.
          if (!hiding) {
            setHidden(true, buttonRef.current);
            setAsking(false);
            return;
          }
          setWrong(false);
          setAsking((open) => !open);
        }}
        aria-pressed="true"
        aria-expanded={asking}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        <span className="when-showing">Hide values</span>
        <span className="when-hiding">Show values</span>
      </button>

      {asking ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const entered = inputRef.current?.value ?? "";
            if (entered !== PRIVACY_PASSWORD) {
              setWrong(true);
              inputRef.current?.select();
              return;
            }
            setHidden(false, buttonRef.current);
            setAsking(false);
            setWrong(false);
          }}
          className="flex items-center gap-2"
        >
          <input
            ref={inputRef}
            type="password"
            // Not a login, and offering to save it in a password manager
            // would misrepresent what it is.
            autoComplete="off"
            aria-label="Password to show values"
            aria-invalid={wrong}
            placeholder={wrong ? "Wrong" : "Password"}
            onChange={() => setWrong(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setAsking(false);
            }}
            className={`w-28 rounded-md border px-2 py-2 text-sm ${
              wrong
                ? "border-amber-500 text-amber-700 placeholder:text-amber-600 dark:text-amber-400 dark:placeholder:text-amber-500"
                : "border-neutral-300 dark:border-neutral-700"
            } bg-transparent`}
          />
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Show
          </button>
        </form>
      ) : null}
    </span>
  );
}

/**
 * Applies the preference before the first paint.
 *
 * Without this the page renders with the totals visible and hides them a frame
 * later, which defeats the point. Inlined in `<head>` and deliberately tiny.
 *
 * Hides unless this browser has been told not to, so a machine that has never
 * entered the password never shows a figure at all.
 */
export function PrivacyScript() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `try{if(localStorage.getItem(${JSON.stringify(PRIVACY_KEY)})!=="0"){document.documentElement.classList.add(${JSON.stringify(PRIVACY_CLASS)})}}catch(e){document.documentElement.classList.add(${JSON.stringify(PRIVACY_CLASS)})}`,
      }}
    />
  );
}
