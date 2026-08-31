# Desktop release matrix

The desktop CI matrix currently supports only Apple Silicon macOS:

| Runner | Tauri target | Bundled Node runtime |
| --- | --- | --- |
| `macos-14` | `aarch64-apple-darwin` | Node 22.13.0 for `aarch64-apple-darwin` |

The workflow runs on pull requests, branch pushes, tags matching `app-v*`, and manual dispatch. Every matrix job installs the same `${{ matrix.target }}` Rust target with `rustup target add`, builds the shared Web/server output and Node host runtime, stages the matching Node sidecar, runs `node scripts/check-desktop-wrapper.mjs`, then explicitly packages with `pnpm exec tauri build --config apps/desktop/tauri.conf.json --target ${{ matrix.target }}`. Thus Rust compilation, staging, and packaging consume the same matrix target.

## Verification paths

Pull requests, branch pushes, and manual dispatches use the verification path. It builds only; it neither receives release secrets nor uploads or publishes a bundle.

## Signed tag path

A release tag must exactly equal `app-v<version>`, where `<version>` is read from `apps/desktop/tauri.conf.json`. Before the signed build starts, the workflow checks that these GitHub Actions secrets are non-empty without printing their values:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

The signed tag build supplies those secrets only to the prerequisite and explicit matrix-target Tauri build steps so Tauri can sign and notarize the package. The workflow does not create a GitHub release, push a tag, or upload an artifact; publication remains a separately authorized operation after CI succeeds.
