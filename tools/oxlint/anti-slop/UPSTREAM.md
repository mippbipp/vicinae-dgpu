# Vendored anti-slop oxlint plugins

Source: `tools/oxlint/anti-slop/` in `mippbipp/sourdough`, commit `33da970f61258700266eec0d4237963fa4f0efb2` (byte-identical to that commit). It was first copied on 2026-10-25 from `deeee46bf2763a6bd57398bf56046f6e814ecd94`, which a sourdough history rewrite later dropped. The plugin files did not change between the two. That copy is the `install-anti-slop` skill's bundled plugin with two local adaptations, kept here unchanged:

- `effect/rules/no-service-constructor-imports.ts` accepts a `packageAliases` option, so bare workspace imports (`@vicinae-dgpu/...` here) count as project-local alongside relative imports.
- `effect/shared/tagged-values.ts` drops `catchAll` from the broad-catch method list. Effect v4 has no `Effect.catchAll`.

`vendor/eslint-stylistic/` keeps its own `UPSTREAM.md` and `LICENSE`.

To update, follow the `install-anti-slop` skill's update procedure and keep both adaptations.
