import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with only the files the server actually needs,
  // which is what keeps the Docker image small — no full node_modules copy.
  output: "standalone",
  // Left for Node to load at runtime rather than bundled.
  //
  // `stream-json` is ESM-only and the ingest modules that use it are `.mts`
  // with `.mjs` import specifiers — the form TypeScript's NodeNext resolution
  // wants, and one Turbopack cannot follow. Keeping them external means the
  // server imports them the way `tsx` does instead of trying to bundle them.
  // `better-sqlite3` is native and could never be bundled regardless.
  serverExternalPackages: ["better-sqlite3", "stream-json", "stream-chain"],
  experimental: {
    serverActions: {
      // A Moxfield export runs roughly 100 bytes per row, so the 1 MB default
      // would reject a collection of more than ~10,000 cards. The CLI importer
      // has no such limit; this is for the upload form.
      bodySizeLimit: "16mb",
    },
  },
};

export default nextConfig;
