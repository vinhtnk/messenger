# Messenger Desktop

A lightweight desktop wrapper for Facebook Messenger, built with [Electron](https://www.electronjs.org/). Created after the official Messenger app for macOS was discontinued.

## Features

- Native macOS app experience with standard menu bar and shortcuts
- **Floating chat bubble** — small always-on-top bubble visible across apps and full-screen spaces; drag to reposition, click to toggle Messenger, right-click for context menu (`Cmd+Shift+B` to toggle)
- **Unread badge** — dock icon and bubble both show the unread message count
- External links open in your default browser; photo/video viewer stays in-app
- Persistent login session and window state (size + position remembered)
- Auto-updates via GitHub Releases

## Installation

### From DMG (Pre-built)

1. Download the latest DMG from [Releases](https://github.com/vinhtnk/messenger/releases)
2. Open the DMG and drag Messenger to Applications

### From Source

```bash
git clone https://github.com/vinhtnk/messenger.git
cd Messenger
npm install

# Run in dev mode
npm start

# Build a signed DMG (requires .env, see Release section)
npm run build:dmg
```

Build artifacts are written to `dist/`.

## Requirements

- Node.js 18+
- macOS 10.15+

## Release

Release scripts bump the version, build, sign, notarize, tag, push, and publish a GitHub Release in one step.

```bash
npm run release            # patch (default)
npm run release:patch
npm run release:minor
npm run release:major
npm run release:rebuild    # rebuild & re-upload current version
```

Requires Apple Developer signing credentials and a GitHub token in `.env`:

```
APPLE_SIGNING_IDENTITY=Developer ID Application: Your Name (TEAMID)
APPLE_ID=you@example.com
APPLE_PASSWORD=app-specific-password
APPLE_TEAM_ID=TEAMID
GH_TOKEN=ghp_...
```

## License

ISC
