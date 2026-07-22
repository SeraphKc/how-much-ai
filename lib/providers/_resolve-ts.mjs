// Test-only module-resolution hook. Source files use extensionless relative imports (matching the
// Next bundler + tsc, which excludes test files and disallows `.ts` import specifiers). Node's
// built-in test runner does not infer extensions, so provider tests import THIS first (statically, so
// it evaluates before the test body) and then dynamically import the `.ts` source under test.
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(pathToFileURL(projectRoot).href) &&
      !context.parentURL.includes("/node_modules/") &&
      path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
