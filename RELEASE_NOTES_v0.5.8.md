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

## Release verification checklist

The following status is intentionally explicit and must be updated from real gate output before publication:

- [x] `npm run check`, `npm test` (137 tests), and `npm run build` passed in the metadata working tree on 2026-07-12
- [x] `cargo metadata --locked` and locked Windows-target Rust tests (65 tests) passed in the metadata working tree on 2026-07-12
- [ ] Clean `npm ci` install repeated for the final release commit
- [ ] Formatting, clippy, npm audit, and cargo audit reviewed
- [ ] Pinned toolchain and native dependency provenance checks completed
- [ ] MSI and NSIS packaging completed
- [ ] Packaged installer/application smoke tests completed with isolated state
- [ ] Credential/artifact scan completed
- [ ] Final independent security, specification, and code-quality review approved

Do not publish or describe v0.5.8 as release-complete until every applicable item above has evidence and the packaging/smoke/final-review items are checked.
