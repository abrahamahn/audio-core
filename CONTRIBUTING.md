# Contributing

Keep `audio-core` deterministic, framework-neutral, and independent of application cue names.
Renderer integrations belong in adapters; product choreography belongs in consuming applications.

Run the complete TypeScript package gate before opening a pull request:

```bash
cd typescript
pnpm install --frozen-lockfile
pnpm prepack
pnpm exec playwright install chromium webkit
pnpm test:browser
pnpm pack --dry-run
```

Every behavioral change needs focused success, failure, invalid-input, and resource-boundary tests
where applicable. Public API changes must update the README and changelog.

Rust changes must also pass:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo check -p abrahamahn-audio-core --target wasm32-unknown-unknown --features wasm
```

Building the npm worklet assets additionally requires `wasm-bindgen-cli` version `0.2.127`.
