## 2025-04-06 - Missing Aria Labels in Repeated Channel Items
**Learning:** Found that channel list buttons like `Fav` and `EPG` inside mapped lists were missing contextual text. A screen reader would just announce "Fav button", "Fav button", "Fav button" making it impossible to know which channel was being targeted.
**Action:** Always verify that buttons within `.map()` iterators use dynamic `aria-label`s based on the row's data (e.g., `Add ${channel.name} to favorites`) to provide context-aware accessibility.

## 2025-04-07 - Missing Aria Labels in Repeated Settings Form Inputs
**Learning:** Found that placeholder-only inputs in settings panels lacked proper `aria-label`s. Inside mapped lists like `SavedSources`, screen readers wouldn't have sufficient context about which specific source an input field like "Username" or "Password" belonged to.
**Action:** Ensure inputs that rely on visual context (e.g., being visually nested inside a specific "source card") explicitly include context-aware `aria-label`s (e.g., `aria-label="Username for ${sourceLabel}"`) to make them fully accessible.
