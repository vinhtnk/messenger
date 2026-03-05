#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env file
if [ -f "$PROJECT_DIR/.env" ]; then
  while IFS='=' read -r key value; do
    # Skip empty lines and comments
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    # Trim whitespace
    key=$(echo "$key" | xargs)
    # Export the variable (value can contain special chars)
    export "$key=$value"
  done < "$PROJECT_DIR/.env"
else
  echo "Error: .env file not found"
  exit 1
fi

# Validate required env vars
for var in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set in .env"
    exit 1
  fi
done

# Determine version bump type (default: patch)
BUMP_TYPE="${1:-patch}"
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

cd "$PROJECT_DIR"

# Bump version in package.json and get new version
npm version "$BUMP_TYPE" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
echo "Building version $VERSION"

# Sync version to tauri.conf.json and Cargo.toml
cd "$PROJECT_DIR/src-tauri"
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" tauri.conf.json
sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" Cargo.toml

cd "$PROJECT_DIR"

# Build with Tauri (signing is automatic when APPLE_SIGNING_IDENTITY is set)
echo "Building and signing..."
cargo tauri build

# Notarize the DMG
DMG_PATH="$PROJECT_DIR/src-tauri/target/release/bundle/dmg/Messenger_${VERSION}_aarch64.dmg"

if [ ! -f "$DMG_PATH" ]; then
  echo "Error: DMG not found at $DMG_PATH"
  exit 1
fi

echo "Notarizing $DMG_PATH..."
xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "Stapling notarization ticket..."
xcrun stapler staple "$DMG_PATH"

echo "Verifying notarization..."
spctl --assess --type open --context context:primary-signature -v "$DMG_PATH" 2>&1 || true

# Git commit and tag
echo "Committing version $VERSION..."
git add -A
git commit -m "$VERSION"
git tag "v$VERSION"

echo ""
echo "Release v$VERSION built and notarized successfully!"
echo "DMG: $DMG_PATH"
echo ""
echo "To publish:"
echo "  git push && git push --tags"
echo "  gh release create v$VERSION '$DMG_PATH' --title 'v$VERSION' --notes-file CHANGELOG.md"
