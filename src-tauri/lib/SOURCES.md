# Native dependency provenance

Onyx packages exactly two Windows x86-64 DLLs. `SHA256SUMS` pins the bytes accepted by `scripts/verify-native-deps.ps1`; the release build runs that verifier before Tauri packaging. A digest proves identity, not trust, so source evidence is recorded separately below.

## `libmpv-wrapper.dll`

- Local SHA-256: `0d5adead5f175c55e0790a80924ec0a2636f72e3675c79a6d9d9568b2ed2384a`
- Architecture: PE32+ x86-64 (`0x8664`)
- Version/source: `libmpv-wrapper` v0.1.1, Windows x86-64 release asset
- Fixed release URL: <https://github.com/nini22P/libmpv-wrapper/releases/download/v0.1.1/libmpv-wrapper-windows-x86_64.zip>
- Upstream archive SHA-256: `d2ff8b2edcd34d2968e544adaa915e5e5c48eb1a0995945005269c2af119a492`
- Verification performed 2026-07-12: the fixed upstream archive was downloaded, its archive digest matched the release manifest, and its extracted DLL matched the local DLL byte-for-byte.

## `libmpv-2.dll`

- Local SHA-256: `1c71c4b893c0ac0a71011c970e2bf096a5b58ea3e0449db749fff0112badfd6e`
- Architecture: PE32+ x86-64 (`0x8664`)
- Embedded file/product version: `v0.41.0-877-ge5486b96d`
- Version/source: mpv `v0.41.0-877-ge5486b96d`, `zhongfly/mpv-winbuild` non-v3 LGPL development archive
- Fixed release URL: <https://github.com/zhongfly/mpv-winbuild/releases/download/2026-07-12-e5486b96d7/mpv-dev-lgpl-x86_64-20260712-git-e5486b96d7.7z>
- Upstream archive SHA-256: `c558312716e7add9166a6240c38c5fbac713b8a76062fdc1c65b1afe2ef32898`
- Extracted upstream DLL SHA-256: `1c71c4b893c0ac0a71011c970e2bf096a5b58ea3e0449db749fff0112badfd6e`
- Verification performed 2026-07-12: the fixed upstream archive was downloaded, its archive digest matched the release manifest, and its extracted DLL replaced and now matches the local DLL byte-for-byte.

## Reproduction rule

Use only the fixed URLs and archive digests above. Do not use `tauri-plugin-libmpv-api setup-lib` for release inputs: version 0.3.2 follows moving `latest` URLs and does not verify downloaded archive hashes. After replacing either DLL, update `SHA256SUMS` only after repeating the archive and extracted-file verification documented here.
