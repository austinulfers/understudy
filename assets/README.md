# Assets

The Understudy mark is two speech bubbles: a purple one (`#8870FC`) behind a
navy one (`#0E142D`) that is smiling. Everything else here derives from it.

| File | What it is |
| --- | --- |
| `logo-editable.svg` | The design source: mark plus wordmark, with the wordmark as live text in Avenir Next Bold (a macOS system font). Edit this one. |
| `logo.svg`, `logo-dark.svg` | The same with the wordmark converted to outlines, so it renders identically without the font. The README shows one or the other through `<picture>`. |
| `mark.svg` | The bubbles alone, transparent, cropped to their bounds. The onboarding window inlines a copy. |
| `icon.svg` → `icon-1024.png`, `../packages/app/icons/app.icns` | macOS app icon on Apple's 1024 grid: an 824 rounded square with 100px margins and a soft shadow. |
| `icon-slack.svg` → `icon-slack-1024.png` | Slack app icon, a full-bleed square (Slack rounds the corners). Upload it at api.slack.com/apps → Basic Information → Display Information. |
| `tray.svg` → `../packages/app/icons/trayTemplate.png`, `trayTemplate@2x.png` | Menu-bar icon as a macOS template image (black plus alpha; the system recolors it) at 22 and 44 px. Its gap, eyes, and smile are a little heavier than the logo's so they survive at that size. |

## Regenerating

```sh
pnpm icons
```

renders every PNG and the `.icns` from the SVGs above with `build-icons.mjs`
(resvg; the `.icns` step needs macOS for `iconutil`). Commit the results.

To change the wordmark, edit the text in `logo-editable.svg`, then outline it
again for `logo.svg` and `logo-dark.svg`:

```sh
swift assets/outline-text.swift "Understudy" AvenirNext-Bold 185 547 629
```

prints the path data for a wordmark centred on x=547 with its baseline at
y=629; paste it into the `<path>` that follows the bubbles in both files.
