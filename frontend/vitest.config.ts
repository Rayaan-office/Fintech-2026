import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type Plugin } from "vitest/config";
import viteConfig from "./vite.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(here, "../tests/frontend");

// Tests live outside the app, so resolve their bare imports (react, vitest, ...) from this package
function resolveFromFrontend(): Plugin {
  const anchor = path.join(here, "src", "main.tsx");
  return {
    name: "resolve-tests-from-frontend",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer?.startsWith(testsDir) || source.startsWith(".") || source.startsWith("/") || source.startsWith("@/") || source.startsWith("\0")) {
        return null;
      }
      return this.resolve(source, anchor, { ...options, skipSelf: true });
    },
  };
}

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [resolveFromFrontend()],
    // Tests sit outside this package; let the test server read them (vitest only, not the dev server)
    server: { fs: { allow: [here, testsDir] } },
    test: {
      root: here,
      include: ["../tests/frontend/**/*.test.tsx"],
      environment: "jsdom",
      setupFiles: [path.join(testsDir, "setup.ts")],
      css: false,
      restoreMocks: true,
      // Node's own experimental localStorage would shadow jsdom's
      execArgv: ["--no-experimental-webstorage"],
    },
  }),
);
