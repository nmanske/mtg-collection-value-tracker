import "server-only";

/**
 * Whether values are hidden until asked for, and what asking costs.
 *
 * Two deployments want opposite things from the same control.
 *
 * A self-hosted instance on a shared network wants everything hidden until a
 * password is typed — the totals are the host's own and other people are
 * walking past the screen. Set `PRIVACY_PASSWORD` and that is what happens.
 *
 * A public instance wants the opposite. The numbers belong to whoever uploaded
 * the file thirty seconds ago; hiding them by default would hide a stranger's
 * own collection from them behind a password they were never given. With the
 * variable unset, values simply show, and the toggle stays as what it was
 * before any of this: a way to cover the screen when someone walks over.
 */
export interface PrivacyConfig {
  /** Null when no password is required to reveal. */
  password: string | null;
  /** Whether a browser that has expressed no preference starts hidden. */
  defaultHidden: boolean;
}

export function privacyConfig(): PrivacyConfig {
  const password = process.env.PRIVACY_PASSWORD?.trim();
  return password
    ? { password, defaultHidden: true }
    : { password: null, defaultHidden: false };
}

/**
 * Whether the host's own collection can be written to from the web.
 *
 * `/import` replaces the host collection wholesale: quantities are set from
 * the file and cards it does not mention are deleted. There is no account
 * system here, so on a public deployment that page is a stranger's button for
 * overwriting somebody else's collection.
 *
 * Default-closed, therefore, and opened by setting `ENABLE_OWNER_IMPORT=true`
 * — which a self-hosted instance should do, and a public one must not. The CLI
 * importer is unaffected: it runs on the host, where whoever runs it already
 * owns the database.
 */
export function ownerImportEnabled(): boolean {
  return process.env.ENABLE_OWNER_IMPORT === "true";
}
