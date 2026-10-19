import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sdkProtocolPath = fileURLToPath(new URL("../sdk/src/relayer-protocol/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@opaque-stellar\/sdk\/relayer-protocol\/(.*)$/,
        replacement: `${sdkProtocolPath}$1`,
      },
    ],
  },
});