import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "*.md",
    "vicinae-env.d.ts",
    // golden inputs and outputs; invalid.json is deliberately not JSON
    "packages/core/test/fixtures/**",
    // vendored oxlint plugin: don't reformat third-party-owned source
    "tools/oxlint/anti-slop/**",
  ],
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  jsxSingleQuote: false,
  trailingComma: "es5",
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: "always",
  endOfLine: "lf",
  sortImports: {},
});
