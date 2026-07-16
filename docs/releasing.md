# Releasing Onyx

Onyx has two supported distribution paths:

- **Microsoft Store** — recommended for normal users and automatic updates.
- **GitHub Releases** — standalone MSI and NSIS installers.

The public Store listing is <https://apps.microsoft.com/detail/9NB7K3TRRKXT>.

## 1. Prepare the version

Start from a clean, synchronized `main` branch:

```powershell
git switch main
git pull --ff-only origin main
python scripts/set-release-version.py 0.6.0
```

The version script updates and verifies:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- the root Onyx package in `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

Add a dated `## vX.Y.Z` section at the top of `CHANGELOG.md`. The tagged release workflow extracts that exact section as the public GitHub release notes and fails closed if it is missing or empty.

Store package versions are generated automatically as `(SemVer major + 1).minor.patch.0`. For example, Onyx `0.6.0` becomes Store package `1.6.0.0`.

## 2. Validate the candidate

Run the focused metadata and source gates:

```powershell
python scripts/test-verify-release-version.py
python scripts/test-set-release-version.py
python scripts/test-extract-changelog.py
python scripts/verify-release-version.py 0.6.0
npm ci
npm test
npm run check
npm run build
npm audit --audit-level=high
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-features --target x86_64-pc-windows-msvc
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-features --all-targets --target x86_64-pc-windows-msvc -- -D warnings
cargo audit --file src-tauri/Cargo.lock
python scripts/test-scan-repository-secrets.py
python scripts/scan-repository-secrets.py --self-test
```

Build every Windows package through the same helper used by release CI:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-release.ps1
```

This produces exactly one MSI, one NSIS installer, one Partner Center MSIX, and deterministic checksum manifests under `src-tauri/target/release/bundle`.

## 3. Commit and verify CI

Commit the version, changelog, and application changes, then push `main`. Wait for **Windows CI** to pass before tagging.

```powershell
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
# Add the actual source/test files for the release as appropriate.
git commit -m "release: prepare Onyx v0.6.0"
git push origin main
```

## 4. Tag and publish GitHub installers

Create an annotated, immutable tag only after branch CI passes:

```powershell
git tag -a v0.6.0 -m "Onyx v0.6.0"
git push origin v0.6.0
```

The **Windows release artifacts** workflow then:

1. verifies the tag against every authoritative version source;
2. repeats frontend, Rust, audit, native-provenance, and secret gates;
3. builds MSI, NSIS, and Store MSIX packages;
4. smoke-tests both standalone installers;
5. uploads all three formats as a private Actions artifact;
6. publishes the MSI, NSIS installer, checksums, and curated changelog section as the public GitHub Release.

It refuses to overwrite an existing public release. Never force-move a published tag.

## 5. Submit the Microsoft Store update

After the tagged workflow succeeds:

1. Download the `onyx-windows-X.Y.Z` artifact from the workflow run.
2. Verify the public standalone installers against the root `SHA256SUMS`.
3. Verify the Partner Center package against `store/SHA256SUMS`, then select the single `.msix` under the Store output.
4. In Partner Center, start an update for **Onyx-IPTV**.
5. Upload the new MSIX and confirm the generated package version is higher than the published version.
6. Update **What's new in this version** from the same changelog section.
7. Preserve the existing pricing, markets, category, privacy URL, support URL, listing screenshots, and certification notes unless the release actually changes them.
8. Submit the update for certification.
9. After publication, install/update through Microsoft Store and smoke-test first launch, source import, playback, persistence after relaunch, and uninstall.

Partner Center submission remains deliberately manual: Microsoft certification is a publication boundary, and no Store credentials or publisher tokens are stored in GitHub Actions.
