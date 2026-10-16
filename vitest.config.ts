import { defineConfig } from "vitest/config";
import { cloudflarePool } from "@cloudflare/vitest-pool-workers";

/** Tests run INSIDE workerd, not Node.
 *
 *  That matters here: the code under test uses `crypto.subtle` (PBKDF2, HMAC, JWT
 *  verification), `TransformStream` and `TextDecoder({stream:true})`. Node's versions of
 *  those differ subtly — notably workerd's PBKDF2 rejects iteration counts above 100,000,
 *  a limit a Node-based test would never surface. Testing on the real runtime keeps the
 *  suite honest about the platform we actually deploy to.
 *
 *  NOTE on the import: `@cloudflare/vitest-pool-workers@0.18` no longer exposes a
 *  `./config` subpath (the older `defineWorkersConfig` recipe in most docs). The pool is
 *  wired through vitest's own `pool` option from the ROOT export instead. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: cloudflarePool({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  },
});
