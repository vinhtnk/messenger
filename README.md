# Messenger Desktop

A lightweight Electron wrapper for Messenger.com, created after the official Messenger app for macOS was discontinued.

## Features

- Native macOS app experience
- Standard macOS menu bar with keyboard shortcuts
- External links open in your default browser
- Facebook login support
- Minimal resource usage

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/vinhtnk/messenger.git
cd Messenger

# Install dependencies
npm install

# Run the app
npm start
```

### Build Distributable

```bash
# Build .dmg and .zip for macOS
npm run build
```

The distributable will be created in the `dist/` folder.

### From DMG (Pre-built)

1. Download the latest DMG from [Releases](https://github.com/vinhtnk/messenger/releases)
2. Open the DMG and drag Messenger to Applications
3. Since the app is not code-signed, run this command to remove the quarantine attribute:

```bash
xattr -cr /Applications/Messenger.app
```

Or go to **System Settings > Privacy & Security** and click **"Open Anyway"**.

## Requirements

- Node.js 18+
- macOS 10.15+

## License

ISC
