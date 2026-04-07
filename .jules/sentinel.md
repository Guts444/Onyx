## 2024-05-15 - [reqwest Error Credential Leak]
**Vulnerability:** `reqwest` connection errors expose the full URL, including sensitive query parameters like `password`, directly to the user/frontend through the error response strings returned by Tauri commands.
**Learning:** Network request libraries often include the requested URL in their debug or stringified errors by default. When APIs use query parameters for authentication (like Xtream does via `player_api.php?username=...&password=...`), these secrets get leaked in UI error notifications.
**Prevention:** Always strip URLs from network errors when returning them to the frontend using library-specific methods (e.g., `reqwest::Error::without_url()`), or catch specific errors to return generic, safe messages.
## 2025-04-06 - [Tauri CSP Disabled]
**Vulnerability:** A missing or disabled (`"csp": null`) Content Security Policy in a Tauri application allows arbitrary script execution, exposing the application to severe Cross-Site Scripting (XSS) attacks.
**Learning:** In desktop environments, XSS can lead to more critical consequences like remote code execution or file system access via IPC (if exposed).
**Prevention:** Always define a strict CSP for Tauri projects that minimally allows 'self', specific required external hosts, and Tauri-specific protocols (`ipc:`, `asset:`). Never leave `"csp": null` in production.
## 2025-05-18 - [reqwest Error Credential Leak during Chunking]
**Vulnerability:** `reqwest` connection and parsing errors while reading chunks stream expose the full URL, including sensitive query parameters like `password`, directly to the user/frontend through the error response strings.
**Learning:** Similar to `.send().await`, reading a stream `.chunk().await` can also fail, and `reqwest` will still include the requested URL with secrets in its debug/stringified errors.
**Prevention:** Always strip URLs from network errors when returning them to the frontend using `reqwest::Error::without_url()` not only on the initial request, but also when iterating over response chunks.
