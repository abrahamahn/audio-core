# Contributing

Keep `audio-core` deterministic, framework-neutral, and independent of application cue names.
Renderer integrations belong in adapters; product choreography belongs in consuming applications.

Run the complete TypeScript package gate before opening a pull request:

```bash
cd typescript
pnpm install --frozen-lockfile
pnpm prepack
pnpm pack --dry-run
```

Every behavioral change needs focused success, failure, invalid-input, and resource-boundary tests
where applicable. Public API changes must update the README and changelog.
