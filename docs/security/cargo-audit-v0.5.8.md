# Cargo audit disposition for Onyx v0.5.8

**Review date:** 2026-07-12

**Release candidate:** `hardening/v0.5.8` at `df70d59`

**Lockfile reviewed:** `src-tauri/Cargo.lock`

## Result and scope

The current audit was run with cargo-audit 0.22.2 against the pinned lockfile:

```text
cargo audit --file src-tauri/Cargo.lock
Loaded 1160 security advisories
Scanning src-tauri/Cargo.lock for vulnerabilities (458 crate dependencies)
warning: 17 allowed warnings found
```

A JSON run (`cargo audit --file src-tauri/Cargo.lock --no-fetch --format json`) confirmed:

- **Vulnerabilities: 0**
- **Warnings: 17** — 16 `unmaintained`, 1 `unsound`
- **Yanked-package warnings: 0**

These are warning dispositions, not claims that the dependencies are risk-free. In particular, “unmaintained” means fixes may not be forthcoming, and target exclusion does not make an advisory generally safe on other platforms. The release lockfile is pinned and CI runs `cargo audit --file src-tauri/Cargo.lock`; future lockfile or advisory-database changes must be reviewed again.

## Windows applicability method

Onyx v0.5.8 is a Windows release. Applicability was checked using the release target and both normal and feature-aware inverse dependency trees:

```text
cargo tree --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc -i <crate>
cargo tree --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc -e features -i <crate>
```

To avoid reading or changing unrelated active worktree edits, the release-candidate `Cargo.toml` and `Cargo.lock` were exported from `df70d59` to a temporary directory for the target-specific tree probes. The probes used `--locked`; the repository manifest and lockfile were not changed by this review.

The results split into two groups:

1. The GTK3/glib family, including `proc-macro-error` reached only through GTK/glib macros, prints `warning: nothing to print` for `x86_64-pc-windows-msvc`. These crates remain in the cross-platform lockfile through Tauri/Wry's non-Windows GTK backend but are **target-inapplicable to the Windows dependency graph**.
2. The five UNIC crates remain in the Windows graph through `urlpattern 0.3.0 -> tauri-utils 2.9.3` (including Tauri runtime/build/codegen paths). They are therefore an **accepted Windows-reachable transitive maintenance risk** for this candidate. Onyx does not declare or call `urlpattern` or the UNIC crates directly; a source search found no Rust references. The audit reports maintenance warnings, not known vulnerabilities, but that is not a guarantee that no defect exists.

## Advisory-by-advisory disposition

All rows were reviewed on **2026-07-12**.

| Advisory | Crate/version | Audit classification | Windows reachability | Rationale | Mitigation / upgrade owner |
|---|---|---|---|---|---|
| [RUSTSEC-2024-0413](https://rustsec.org/advisories/RUSTSEC-2024-0413) | `atk 0.18.2` | Warning — unmaintained | No; target-inapplicable | GTK3 accessibility binding; Windows inverse and feature trees contain no path. It exists in the lockfile through Tauri/Wry's non-Windows GTK backend. | Release maintainer: monitor Tauri/Wry GTK backend updates and refresh the lockfile when upstream removes/replaces GTK3 bindings. |
| [RUSTSEC-2024-0416](https://rustsec.org/advisories/RUSTSEC-2024-0416) | `atk-sys 0.18.2` | Warning — unmaintained | No; target-inapplicable | GTK3 accessibility FFI binding; absent from the Windows target graph and present only through the non-Windows GTK chain. | Release maintainer: adopt the upstream Tauri/Wry GTK dependency migration when available; re-audit every lockfile update. |
| [RUSTSEC-2024-0412](https://rustsec.org/advisories/RUSTSEC-2024-0412) | `gdk 0.18.2` | Warning — unmaintained | No; target-inapplicable | GTK3 GDK binding; Windows target tree prints no dependency path. | Release maintainer: track Tauri/Wry replacement of GTK3 dependencies and update through supported upstream releases. |
| [RUSTSEC-2024-0418](https://rustsec.org/advisories/RUSTSEC-2024-0418) | `gdk-sys 0.18.2` | Warning — unmaintained | No; target-inapplicable | GTK3 GDK FFI binding; absent from the Windows target graph. | Release maintainer: track and adopt the upstream Tauri/Wry GTK migration; keep CI audit enabled. |
| [RUSTSEC-2024-0411](https://rustsec.org/advisories/RUSTSEC-2024-0411) | `gdkwayland-sys 0.18.2` | Warning — unmaintained | No; target-inapplicable | Wayland-specific GTK3 FFI binding; no Windows target path. | Release maintainer: refresh via upstream Tauri/Wry Linux backend updates; it must be reassessed before any Linux release. |
| [RUSTSEC-2024-0417](https://rustsec.org/advisories/RUSTSEC-2024-0417) | `gdkx11 0.18.2` | Warning — unmaintained | No; target-inapplicable | X11-specific GTK3 GDK binding; no Windows target path. | Release maintainer: refresh via upstream Tauri/Wry Linux backend updates; reassess for any Linux release. |
| [RUSTSEC-2024-0414](https://rustsec.org/advisories/RUSTSEC-2024-0414) | `gdkx11-sys 0.18.2` | Warning — unmaintained | No; target-inapplicable | X11-specific GTK3 FFI binding; absent from the Windows target graph. | Release maintainer: adopt upstream Tauri/Wry Linux dependency updates and re-audit before Linux support. |
| [RUSTSEC-2024-0415](https://rustsec.org/advisories/RUSTSEC-2024-0415) | `gtk 0.18.2` | Warning — unmaintained | No; target-inapplicable | GTK3 binding used by Tauri/Wry only on non-Windows targets; Windows target tree prints no path. | Release maintainer: monitor Tauri/Wry for a supported non-GTK3 backend/dependency upgrade and update the pinned graph when available. |
| [RUSTSEC-2024-0420](https://rustsec.org/advisories/RUSTSEC-2024-0420) | `gtk-sys 0.18.2` | Warning — unmaintained | No; target-inapplicable | GTK3 FFI binding; absent from the Windows target graph. | Release maintainer: adopt upstream Tauri/Wry GTK dependency updates and retain audit review on every release. |
| [RUSTSEC-2024-0419](https://rustsec.org/advisories/RUSTSEC-2024-0419) | `gtk3-macros 0.18.2` | Warning — unmaintained | No; target-inapplicable | GTK3 procedural macros; the Windows target graph contains no path. | Release maintainer: update through Tauri/Wry's supported GTK dependency chain when upstream migrates. |
| [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370) | `proc-macro-error 1.0.4` | Warning — unmaintained | No; target-inapplicable | All-target tracing reaches it only through `glib-macros` and `gtk3-macros`; neither path is selected for Windows. | Release maintainer: monitor GTK/glib macro upgrades inherited from Tauri/Wry; do not add a direct dependency. |
| [RUSTSEC-2025-0081](https://rustsec.org/advisories/RUSTSEC-2025-0081) | `unic-char-property 0.9.0` | Warning — unmaintained | **Yes; transitive** | Windows path is `unic-char-property -> unic-ucd-ident -> urlpattern -> tauri-utils`. No direct Onyx use and no known vulnerability is reported by this audit, but maintenance risk remains. | Release maintainer: track `urlpattern`/`tauri-utils` replacement or upgrade; adopt a supported upstream Tauri release and re-audit. |
| [RUSTSEC-2025-0075](https://rustsec.org/advisories/RUSTSEC-2025-0075) | `unic-char-range 0.9.0` | Warning — unmaintained | **Yes; transitive** | Windows path feeds `unic-char-property`/`unic-ucd-ident`, then `urlpattern -> tauri-utils`. Not called directly by Onyx; accepted only as a pinned transitive maintenance risk. | Release maintainer: track upstream `urlpattern`/`tauri-utils` remediation and update the lockfile once supported. |
| [RUSTSEC-2025-0080](https://rustsec.org/advisories/RUSTSEC-2025-0080) | `unic-common 0.9.0` | Warning — unmaintained | **Yes; transitive** | Windows path is `unic-common -> unic-ucd-version -> unic-ucd-ident -> urlpattern -> tauri-utils`. Audit reports no known vulnerability; lack of maintenance remains a risk. | Release maintainer: monitor Tauri/`tauri-utils` dependency updates and re-evaluate at each release. |
| [RUSTSEC-2025-0100](https://rustsec.org/advisories/RUSTSEC-2025-0100) | `unic-ucd-ident 0.9.0` | Warning — unmaintained | **Yes; transitive** | Direct Windows transitive path is `unic-ucd-ident -> urlpattern -> tauri-utils`; feature tracing shows `id` and `xid` features enabled. Onyx has no direct calls. | Release maintainer: prioritize an upstream Tauri/`urlpattern` upgrade that removes the unmaintained UNIC chain; continue CI detection. |
| [RUSTSEC-2025-0098](https://rustsec.org/advisories/RUSTSEC-2025-0098) | `unic-ucd-version 0.9.0` | Warning — unmaintained | **Yes; transitive** | Windows path is `unic-ucd-version -> unic-ucd-ident -> urlpattern -> tauri-utils`. It is not app code, but remains in both runtime and build/codegen portions of the graph. | Release maintainer: track Tauri/`tauri-utils` and `urlpattern` maintenance releases; update and re-audit when compatible. |
| [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429) | `glib 0.18.5` | Warning — **unsound** | No; target-inapplicable | Advisory concerns `glib::VariantStrIter`. `glib` has no Windows target path; all-target tracing places it in Tauri/Wry's non-Windows GTK stack. This disposition does not claim the affected API is safe on GTK targets. | Release maintainer: adopt Tauri/Wry's upgraded GTK/glib chain when supported; block any future non-Windows release until separately reviewed. |

## Acceptance and follow-up

For the Windows-only v0.5.8 candidate, the 12 GTK/glib-chain warnings are accepted as target-inapplicable and the five UNIC warnings are accepted as Windows-reachable transitive maintenance risk. This closes the cargo-audit review documentation gate only. It does not close formatting, clippy, npm audit, packaging, installer smoke testing, artifact scanning, or final release approval.

Follow-up ownership remains with the release maintainer: keep `Cargo.lock` pinned, retain CI cargo-audit execution, monitor RustSec and upstream Tauri/Wry/`tauri-utils`/`urlpattern` releases, and repeat both audit and Windows-target tracing whenever the lockfile changes or before the candidate is published.
