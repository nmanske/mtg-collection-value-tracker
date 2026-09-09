import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
