# Session Keeper

A Manifest V3 Chrome extension inspired by Session Buddy-style tab/session management.

## Features

- Full-page dashboard opened from the extension toolbar.
- Custom toolbar icon for easier identification in Chrome.
- Local-first session storage using `chrome.storage.local`.
- Screenshot thumbnails are stored locally in IndexedDB and referenced from sessions by ID.
- Automatic session snapshots on a routine alarm, defaulting to every 15 minutes.
- Manual save flow that prompts for a session name.
- Manual saves default to the same timestamp naming style as autosaves.
- Manual saves are tagged `manual` and use a warm highlight color; autosaves are tagged `auto` and use a quieter color.
- Search across saved session names, tab titles, and URLs.
- View current open tabs grouped by window.
- View saved session tabs grouped by window.
- Capture and display screenshot thumbnails from tabs as you browse.
- Restore a saved session into new browser windows.
- Copy all links from the current browser or selected session as a fenced `text` code block.
- Export all links from the current browser or selected session as a `.txt` file.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select:

   ```text
   session-keeper
   ```

5. Click the extension icon to open the dashboard.

## Notes

- Autosaves are stored locally and trimmed to the newest 80 autosaves by default.
- Thumbnail image data is local to this Chrome profile; session records only keep lightweight thumbnail IDs.
- Chrome only allows screenshot capture from the visible tab, so Session Keeper caches thumbnails passively while tabs are already active instead of switching across your tabs during save.
- TXT exports contain one URL per line.
- Clipboard copies are formatted like:

  ```text
  https://example.com/one
  https://example.com/two
  ```

- Opening `dashboard.html` directly in a browser shows demo data. Live tab access, restore, autosave, and downloads require loading the folder as an unpacked extension.
