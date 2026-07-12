# Onyx v0.5.8 Release Notes

**Metadata date:** 2026-07-12

**Status:** Hardened release candidate metadata; packaging, installer smoke testing, and final release review are pending.

Onyx v0.5.8 hardens credential handling, local-state integrity, EPG processing, and release inputs. These notes describe the code and metadata prepared for verification; they do not certify that installers have been built or approved for publication.

## Security and privacy

- Xtream passwords, remote M3U URLs, and EPG URLs are stored in Windows Credential Manager and hydrated only into live application memory.
- Saved source state, playlist snapshots, EPG source state, cache IDs, logs, and diagnostics avoid credential-bearing URLs.
- Existing compatible records migrate to stable, URL-free source/channel/cache identities while preserving favorites, recents, selection, and manual EPG mappings where a safe match is available.
- Production CSP and Tauri IPC capabilities are narrowed to the required surface.
- Development uses a separate application identifier, local-data directory, credential-store namespace, product/title, and localhost-specific CSP overlay, preventing development runs from reading or overwriting production state and credentials.
- Onyx remains local-first and has no analytics, telemetry, cloud backend, or account sync.

## Integrity and recovery

- App-state and EPG-cache writes are bounded, serialized, and atomically replaced with validated backups.
- Corrupt safe primaries can recover from backup. Invalid, oversized, or credential-bearing legacy artifacts are quarantined or securely discarded rather than promoted as recovery data.
- Credential-store and migration failures avoid committing partial source or guide changes.
- Source and guide operation identities reject stale refresh, hydration, edit, selection, and deletion results.

## EPG reliability

- Download, decoded-XML, cache, and diagnostic sample sizes are bounded.
- Gzip input is detected by content and decoded once.
- Malformed programmes are skipped with bounded, credential-free diagnostics instead of rejecting an otherwise usable guide.
- Cache recovery and refresh generations prevent corrupt or stale work from replacing current guide state.

## Reproducible release inputs

- `package.json` and `package-lock.json` are the authoritative npm dependency graph; builds use `npm ci` and do not use a second JavaScript lockfile.
- Node, npm, and Rust versions are pinned by `.nvmrc`, `package.json`, and `rust-toolchain.toml`.
- Native DLL sources use fixed release URLs and recorded archive/extracted-file hashes in `src-tauri/lib/SOURCES.md` and `src-tauri/lib/SHA256SUMS`.
- The release helper checks the pinned toolchain and native DLL bytes before starting Tauri packaging.

## Cargo audit disposition

The 2026-07-12 pinned-lockfile audit reports **0 vulnerabilities** and **17 warnings**: 16 unmaintained and 1 unsound, with no yanked-package warnings. Windows-target dependency tracing excludes 12 GTK/glib-chain warnings from the `x86_64-pc-windows-msvc` graph; five unmaintained UNIC crates remain transitively reachable through `urlpattern -> tauri-utils` and are accepted for this candidate as a documented maintenance risk, not as application code or as a claim of safety. See [the complete advisory-by-advisory disposition](docs/security/cargo-audit-v0.5.8.md).

## Release verification checklist

The following status is intentionally explicit and must be updated from real gate output before publication:

- [x] Clean `npm ci`, `npm run check`, `npm test` (**157 tests**), and `npm run build` passed at `7b3ceae` on 2026-07-12
- [x] Locked Windows-target Rust tests (**73 tests**) passed at `7b3ceae` on 2026-07-12
- [x] Rust formatting, strict Clippy (`-D warnings`), and npm audit (**0 vulnerabilities**) passed
- [x] Cargo audit warnings reviewed and dispositioned in [`docs/security/cargo-audit-v0.5.8.md`](docs/security/cargo-audit-v0.5.8.md) on 2026-07-12
- [x] Pinned Node 24.18.0, npm 11.16.0, Rust 1.95.0, and native dependency hash/PE checks completed
- [x] MSI and NSIS packaging completed from locked dependencies
- [x] Packaged smoke completed with isolated state: MSI administrative extraction, NSIS silent install, exact production window title, stability window, payload checks, cleanup, and restoration of the pre-existing app-data directory
- [x] Windows Credential Manager save/load/delete roundtrip passed with a temporary non-secret `example.invalid` value; the smoke credential was confirmed absent afterward
- [x] Credential/artifact scan completed for `dist`, MSI extraction, NSIS installation, and final bundle directories
- [ ] Final independent security, specification, and code-quality review approved

Final local artifacts:

- `Onyx_0.5.8_x64_en-US.msi` — 45,084,672 bytes — SHA-256 `eb5fca47fd2f9c9280886f848b02cb989841deb78d3211b793ee3e4609074722`
- `Onyx_0.5.8_x64-setup.exe` — 33,436,975 bytes — SHA-256 `e231980333b8bac6aedb5636451aabd5e06d3d25e185da65ca25692cd46f207c`

Do not publish or describe v0.5.8 as release-complete until every applicable item above has evidence and the packaging/smoke/final-review items are checked.
