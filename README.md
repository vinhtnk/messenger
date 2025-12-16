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
git clone https://github.com/yourusername/Messenger.git
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

## Requirements

- Node.js 18+
- macOS 10.15+

## License

ISC
