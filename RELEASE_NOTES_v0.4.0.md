# Onyx v0.4.0 Release Notes

We've focused heavily on making Onyx faster, safer, and cleaner in this update. 

## 🚀 What's New

### Security & Architecture
- **Tauri v2 Migration**: Onyx has been cleanly updated to initialize with the newer Tauri v2 structure. This brings a huge boost in inherent security, better capabilities management, and future-proofs the application framework.
- **Source Management**: Built a brand new, robust source profile management foundation for playlists and user credentials.

### ⚡ Speed & UX Enhancements
- **Lazy Guide Lookups**: The UI is now dramatically faster when browsing large playlists. Rather than loading the whole TV guide up front, Onyx lazily fetches data as you need it.
- **Lightning-Fast Lookups**: Overhauled the algorithms behind the scenes for cross-referencing and matching channels, vastly reducing the time it takes to navigate your lists.
- **EPG Loop Optimization**: The background processing for Electronic Program Guides (XMLTV) now consumes far fewer resources.

### 🧹 Code Health
- Refactored our hashing extractions and completely purged several blocks of unused legacy logic (`upsertImportedSource`, `createepgchannelkey`, etc.) to keep the bundle lean and maintainable.
