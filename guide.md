# Prior CLI — Release & Update Guide

How `prior-cli` is built, versioned, shipped, and updated across **two channels**:

| Channel | For | Source of truth |
|---|---|---|
| **npm** (`prior-cli`) | Anyone with Node.js ≥ 16 | <https://www.npmjs.com/package/prior-cli> |
| **Standalone `prior.exe`** | Windows users with **no Node.js** | [GitHub Releases](https://github.com/PriorNetwork/prior-cli/releases) |

Both come out of the **same version** in `package.json` — never let them drift.

---

## TL;DR — cutting a normal release

```bash
# 1. bump version (updates package.json + package-lock.json)
npm version 1.7.15 --no-git-tag-version

# 2. add a CHANGELOG.md entry for 1.7.15

# 3. commit + push  (NO "Co-Authored-By: Claude" trailer — house rule)
git add -A && git commit -m "v1.7.15 — <summary>"
git -c http.sslBackend=schannel push origin main      # schannel = needed on the TLS-proxied dev box

# 4. tag + push the tag  →  publish.yml publishes to npm automatically
git tag v1.7.15 && git -c http.sslBackend=schannel push origin v1.7.15

# 5. create a GitHub Release for v1.7.15  →  build-exe.yml builds prior.exe
#    and attaches it automatically (see below)
```

Then verify:
- `npm view prior-cli version` → new version
- `https://github.com/PriorNetwork/prior-cli/releases/latest/download/prior.exe` → 302-redirects to the new tag

That's it. **You do not build the exe by hand for releases** — CI does it.

---

## The two CI workflows

- **`.github/workflows/publish.yml`** — triggers on tag push (`v*`), runs `npm publish` (needs the `NPM_TOKEN` repo secret).
- **`.github/workflows/build-exe.yml`** — triggers on **release published** (or manual `workflow_dispatch` with a `tag` input). Builds `prior.exe` on `windows-latest` with `@yao-pkg/pkg` and uploads it to the release via `gh release upload "$TAG" prior-build/prior.exe --clobber`.

> On a clean GitHub runner pkg can fetch its base Node binary normally, so CI needs **no** TLS workaround. This is the preferred way to produce the exe.

Manually re-run the exe build for an existing tag:
```bash
# via API (workflow_dispatch)
curl -s --ssl-no-revoke -X POST \
  -H "Authorization: Bearer <PAT-with-repo>" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/PriorNetwork/prior-cli/actions/workflows/build-exe.yml/dispatches \
  -d '{"ref":"main","inputs":{"tag":"v1.7.15"}}'
```

---

## How the self-updater works (`/update` and `prior update`)

`bin/prior.js` detects whether it's running as the bundled exe:

```js
const IS_EXE = !!process.pkg || (execBase !== 'node.exe' && execBase !== 'node');
```

- **exe** → checks the GitHub Releases API, finds the asset matching `/prior.*\.exe$/i`,
  downloads it, and swaps it in: rename the running exe → `prior.old.exe`, move the new
  build to `prior.exe`. The `.old.exe` is deleted on the next launch (a running exe can't
  delete itself, but Windows *can* rename one).
- **npm** → runs `npm install -g prior-cli@latest`.

**Keep the release asset named exactly `prior.exe`** — the self-updater *and* the website
download button both depend on it.

---

## Building the exe locally (fallback — e.g. the dev machine)

Only needed if you can't use CI. Tool: **`@yao-pkg/pkg`** (the maintained pkg fork).

```bash
npm install -g @yao-pkg/pkg
cd prior-cli
pkg . --targets node20-win-x64 --output prior-build/prior.exe
```

### Gotcha on a TLS-intercepting machine (this dev box)

A corporate/AV TLS proxy blocks pkg from downloading its prebuilt base Node binary, so pkg
falls back to **compiling Node from source** — which needs Visual Studio C++ build tools
(`vcbuild.bat`) that aren't installed, and it fails.

**Fix:** download the prebuilt base binary yourself (curl's `--ssl-no-revoke` gets past the
proxy cert), then point pkg at it with `PKG_NODE_PATH`:

```bash
# 1. grab the prebuilt patched-Node binary into the pkg cache
curl -sL --ssl-no-revoke \
  https://github.com/yao-pkg/pkg-fetch/releases/download/v3.5/node-v20.20.2-win-x64 \
  -o ~/.pkg-cache/fetched-v20.20.2-win-x64
#    (sanity: first two bytes should be "MZ" — a Windows PE exe, not gzip)

# 2. build using it directly — skips the broken download
PKG_NODE_PATH=~/.pkg-cache/fetched-v20.20.2-win-x64 \
  pkg . --targets node20-win-x64 --output prior-build/prior.exe
```

The base-binary version is tied to the installed pkg-fetch version:
- `@yao-pkg/pkg` 6.20.0 → `@yao-pkg/pkg-fetch` 3.6.3 → Node **v20.20.2** for win-x64.
- That prebuilt lives in the **`v3.5`** release of `yao-pkg/pkg-fetch` (asset
  `node-v20.20.2-win-x64`). If you upgrade pkg, find the matching prebuilt by checking
  `~/.pkg-cache/node/node-vXX.XX.X.tar.gz` (the version pkg wants) and browsing the
  `yao-pkg/pkg-fetch` releases for `node-vXX.XX.X-win-x64`.

The `xdg-open` warnings during the build are harmless — that's a *Linux* helper from the
`open` package, unused on Windows.

---

## Constraints & gotchas

- **Bundled runtime is Node 20**, which lacks `--use-system-ca` (Node 22+ only). On the dev
  machine's TLS proxy, *live network calls from the exe fail* — that's the proxy, not a bug.
  Normal users have no such proxy and are unaffected.
- **Unsigned exe** → Windows SmartScreen / antivirus shows a "are you sure?" warning on first
  run. That's a *reputation/signing* thing, **not** a permissions/elevation prompt — the exe
  runs with the same user-level permissions as the npm version (e.g. it still falls back to
  `~/Downloads` when the cwd needs admin, like `C:\Windows\System32`). Code-signing removes
  the warning but needs a paid cert.
- **`prior-build/` is gitignored** — the binary ships via Releases, never committed to the repo.
- **`prior` running from a TTY**: `prior --version` / `-v` currently drop into the chat banner
  because of the entry-point arg dispatch (a single `-x` arg that isn't `-h/--help` launches
  chat). Known quirk; use `prior --help` to see commands.

---

## Where things live

- **Repo:** <https://github.com/PriorNetwork/prior-cli>  (org: `PriorNetwork`)
- **npm:** <https://www.npmjs.com/package/prior-cli>
- **Releases (exe):** <https://github.com/PriorNetwork/prior-cli/releases>
- **Website download button:** `C:\XAMMP\htdocs\prior-utilities.html` → links to
  `releases/latest/download/prior.exe` (and shows the `npm install -g prior-cli` alternative)
- **CLI backend (NOT in the npm package):** `C:\XAMMP\htdocs\prior-cli-backend`
  (pm2 process **Prior-CLI**, id 13) — routes to the main Prior AI backend / Ollama.

---

## Release checklist

- [ ] Bump version in `package.json` (`npm version …`)
- [ ] Update `CHANGELOG.md`
- [ ] Commit + push `main` (no Claude co-author trailer)
- [ ] Push tag `vX.Y.Z` → npm publishes via `publish.yml`
- [ ] Create a GitHub Release for `vX.Y.Z` → exe builds via `build-exe.yml`
- [ ] Verify `npm view prior-cli version` and `releases/latest/download/prior.exe`
