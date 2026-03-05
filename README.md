# Messenger Desktop

A lightweight native wrapper for Facebook Messenger, built with [Tauri](https://tauri.app). Created after the official Messenger app for macOS was discontinued.

## Features

- Native macOS app experience using system WebKit (no bundled browser)
- Standard macOS menu bar with keyboard shortcuts
- External links open in your default browser
- Facebook login support
- Window state persistence (remembers size and position)
- Lightweight ~10MB DMG (vs ~150MB+ with Electron)

## Installation

### From DMG (Pre-built)

1. Download the latest DMG from [Releases](https://github.com/vinhtnk/messenger/releases)
2. Open the DMG and drag Messenger to Applications

### From Source

```bash
# Clone the repository
git clone https://github.com/vinhtnk/messenger.git
cd Messenger

# Run in dev mode
npm start

# Build DMG
npm run build:dmg
```

The DMG will be created in `src-tauri/target/release/bundle/dmg/`.

## Requirements

- [Rust](https://rustup.rs/) 1.70+
- Node.js 18+
- macOS 10.15+

## Release

```bash
# Bump version, build, sign, notarize, and tag
./scripts/release.sh          # patch
./scripts/release.sh minor    # minor
./scripts/release.sh major    # major
```

Requires Apple Developer signing credentials in `.env` (see `.env.example`).

## License

ISC
