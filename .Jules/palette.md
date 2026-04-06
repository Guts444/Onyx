## 2025-04-06 - Missing Aria Labels in Repeated Channel Items
**Learning:** Found that channel list buttons like `Fav` and `EPG` inside mapped lists were missing contextual text. A screen reader would just announce "Fav button", "Fav button", "Fav button" making it impossible to know which channel was being targeted.
**Action:** Always verify that buttons within `.map()` iterators use dynamic `aria-label`s based on the row's data (e.g., `Add ${channel.name} to favorites`) to provide context-aware accessibility.
