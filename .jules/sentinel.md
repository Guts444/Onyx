## 2024-05-15 - [reqwest Error Credential Leak]
**Vulnerability:** `reqwest` connection errors expose the full URL, including sensitive query parameters like `password`, directly to the user/frontend through the error response strings returned by Tauri commands.
**Learning:** Network request libraries often include the requested URL in their debug or stringified errors by default. When APIs use query parameters for authentication (like Xtream does via `player_api.php?username=...&password=...`), these secrets get leaked in UI error notifications.
**Prevention:** Always strip URLs from network errors when returning them to the frontend using library-specific methods (e.g., `reqwest::Error::without_url()`), or catch specific errors to return generic, safe messages.
