import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Lets a test import a `supabase/functions/_shared` module that uses a Deno
 * `npm:` specifier — those modules are shared deliberately (the frontend's
 * lib shims re-export the pure ones), and Vite cannot resolve `npm:pkg@ver`.
 * Stripping the prefix and the version pins resolution back at the
 * node_modules copy. Test-time only. (Carried from the prime, which found
 * this the hard way when a whole suite died at collection.)
 */
function denoNpmSpecifiers(): Plugin {
  return {
    name: "deno-npm-specifiers",
    enforce: "pre",
    async resolveId(id) {
      if (!id.startsWith("npm:")) return null;
      const bare = id.slice("npm:".length);
      // Scoped packages keep their leading @; only a trailing @version goes.
      const at = bare.lastIndexOf("@");
      const name = at > 0 ? bare.slice(0, at) : bare;
      const resolved = await this.resolve(name, undefined, { skipSelf: true });
      if (resolved) return resolved;
      /**
       * Not installed here, and deliberately so: a shared edge module may
       * import a package only its Deno runtime ever calls. The stub throws a
       * named error if a test actually reaches it, so this can never turn a
       * real dependency into a silent pass.
       */
      return path.resolve(__dirname, "./src/test/uninstalledDenoPackageStub.ts");
    },
  };
}

export default defineConfig({
  plugins: [denoNpmSpecifiers(), react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      /**
       * The PDF worker's own modules import the Workers runtime base class.
       * Aliasing it to a thin stub is what lets its auth, routing and wire
       * shape be tested here instead of only in a deploy.
       */
      {
        find: "cloudflare:workers",
        replacement: path.resolve(__dirname, "./src/test/cloudflareWorkersStub.ts"),
      },
    ],
  },
});
