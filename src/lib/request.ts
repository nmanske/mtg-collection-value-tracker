/**
 * Facts about the incoming request, kept free of `server-only` so the pure
 * parts can be tested outside a Next.js runtime.
 */

/**
 * Whether this request reached the proxy over HTTPS, by its own account.
 *
 * The header is a comma-separated list when a request has passed through more
 * than one proxy, and the first entry is the client's hop — the one that
 * decides whether a browser will keep a `Secure` cookie.
 *
 * Absent means nothing claimed HTTPS, so: not secure. That is the safe
 * direction for this particular decision. Marking a cookie `Secure` when the
 * connection is plain HTTP does not protect anything — the browser simply
 * discards the cookie, and every session silently ends at the next click.
 */
export function isSecureRequest(forwardedProto: string | null): boolean {
  if (!forwardedProto) return false;
  return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
}

/**
 * Who the request came from, as well as a proxy will say.
 *
 * `x-forwarded-for` is a list, appended to by each hop, and the first entry is
 * the client as the outermost proxy saw it. Later entries are the proxies
 * themselves. The client can forge the earlier entries if nothing rewrites the
 * header, which is a reason to treat this as a rate-limit key and never as
 * identity or authorisation.
 *
 * Falls back to a constant, so a deployment with no proxy limits everybody
 * together rather than accidentally limiting nobody.
 */
export function clientAddress(
  forwardedFor: string | null,
  realIp: string | null = null,
): string {
  const first = forwardedFor?.split(",")[0]?.trim();
  return first || realIp?.trim() || "unknown";
}
