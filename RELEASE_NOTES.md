# Onyx v0.4.4 - Release Notes

We are excited to bring you the latest cumulative update that unifies the changes from the internal `v0.4.3` branch with the latest `v0.4.4` improvements! 

## Change Summary

- **Security Improvements 🛡️**
  - **Sentinel**: Resolved high-severity `Math.random()` engine vulnerabilities to ensure secure cryptographic and general randomness generation logic. 

- **Performance & Efficiency ⚡** 
  - **Bolt**: Vastly improved visible EPG channel key computations inside `App.tsx`, providing a much snappier interface for channels listing.
  - **Bolt**: Hoisted loop-invariant computations inside EPG search algorithms, achieving faster, non-blocking UI interactions while searching your EPG data.

- **Accessibility & UX 🎨**
  - **Palette**: Introduced contextual ARIA labels to group toggles across the application for improved screen reader support and accessibility.

- **Stability & Testing 🧪**
  - Robust Tauri backend configuration setup for EPG source management.
  - Extensive test coverage added across the domain:
      - Normalizing EPG lookup texts and stream references (edge cases handled).
      - EPG URL key normalizations and Label validation/sanitization logic. 
      - Safe EPG Update interval handlers and extensive tests for EPG source creation processes.

## Upgrading
Just auto-install the newer release using your platform's installer. Enjoy the smoother experience!
