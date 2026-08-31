# Desktop Node runtime staging

The Tauri bundle ships the Node runtime required by `apps/server`; end users do not need to install Node.

Stage a sidecar for the Tauri target before making a desktop bundle:

```sh
node scripts/stage-desktop-node-runtime.mjs --target aarch64-apple-darwin
```

The script downloads the pinned Node `22.13.0` release only when it is absent from
`apps/desktop/.cache/node-runtime`, verifies its hard-coded SHA-256 checksum, then copies its
executable into `apps/desktop/binaries/einfach-agent-node-<target>[.exe]`.

The cache and executable are ignored by Git. On macOS and Linux the script extracts a `.tar.gz`
archive and marks `bin/node` executable. On Windows it extracts the `.zip` archive with PowerShell
and stages `node.exe`. Windows archives must be staged on Windows.

After staging, verify the bundled runtime directly:

```sh
apps/desktop/binaries/einfach-agent-node-aarch64-apple-darwin --version
```

Run the stager tests with:

```sh
node scripts/stage-desktop-node-runtime.test.mjs
```
