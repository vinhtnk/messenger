#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env file
if [ -f "$PROJECT_DIR/.env" ]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    key=$(echo "$key" | xargs)
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

# Set electron-builder signing env vars
export CSC_NAME="$APPLE_SIGNING_IDENTITY"
export CSC_IDENTITY_AUTO_DISCOVERY=true
# electron-builder notarization (notarize: true in package.json)
export APPLE_ID="$APPLE_ID"
export APPLE_APP_SPECIFIC_PASSWORD="$APPLE_PASSWORD"
export APPLE_TEAM_ID="$APPLE_TEAM_ID"

# Determine version bump type or rebuild mode
BUMP_TYPE="${1:-patch}"
REBUILD=false

if [[ "$BUMP_TYPE" == "--rebuild" ]]; then
  REBUILD=true
elif [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: $0 [patch|minor|major|--rebuild]"
  exit 1
fi

cd "$PROJECT_DIR"

if [ "$REBUILD" = true ]; then
  VERSION=$(node -p "require('./package.json').version")
  echo "Rebuilding version $VERSION"
else
  npm version "$BUMP_TYPE" --no-git-tag-version
  VERSION=$(node -p "require('./package.json').version")
  echo "Building version $VERSION"

  # Auto-generate changelog entry from git commits since last tag
  LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  if [ -n "$LAST_TAG" ]; then
    COMMITS=$(git log "${LAST_TAG}..HEAD" --pretty=format:"- %s" --no-merges | grep -v "Co-Authored-By" | grep -v "^- [0-9]*\.[0-9]*\.[0-9]*$")
  else
    COMMITS="- Initial release"
  fi

  if [ -n "$COMMITS" ]; then
    TMPFILE=$(mktemp)
    echo "# Changelog" > "$TMPFILE"
    echo "" >> "$TMPFILE"
    echo "## v${VERSION}" >> "$TMPFILE"
    echo "$COMMITS" >> "$TMPFILE"
    echo "" >> "$TMPFILE"
    tail -n +2 CHANGELOG.md >> "$TMPFILE"
    mv "$TMPFILE" CHANGELOG.md
    echo "Updated CHANGELOG.md with v$VERSION"
  fi
fi

# Clean previous build
rm -rf "$PROJECT_DIR/dist"

# Build with electron-builder (signs + notarizes .app, creates DMG + ZIP)
echo "Building, signing, and notarizing..."
npx electron-builder --mac --publish never

# Find built artifacts
DIST_DIR="$PROJECT_DIR/dist"
DMG_PATH=$(find "$DIST_DIR" -name "*.dmg" -type f | head -1)
ZIP_PATH=$(find "$DIST_DIR" -name "*.zip" -not -name "*.blockmap" -type f | head -1)
YML_PATH="$DIST_DIR/latest-mac.yml"

if [ -z "$DMG_PATH" ]; then
  echo "Error: DMG not found in $DIST_DIR"
  exit 1
fi

echo "DMG: $DMG_PATH"
[ -n "$ZIP_PATH" ] && echo "ZIP: $ZIP_PATH"

# Staple notarization ticket to DMG
echo "Stapling notarization ticket to DMG..."
xcrun stapler staple "$DMG_PATH"

echo "Verifying..."
spctl --assess --type open --context context:primary-signature -v "$DMG_PATH" 2>&1 || true

if [ "$REBUILD" = true ]; then
  echo "Replacing assets on GitHub release v$VERSION..."
  UPLOAD_FILES=("$DMG_PATH")
  [ -n "$ZIP_PATH" ] && UPLOAD_FILES+=("$ZIP_PATH")
  [ -f "$YML_PATH" ] && UPLOAD_FILES+=("$YML_PATH")

  gh release upload "v$VERSION" "${UPLOAD_FILES[@]}" --clobber
else
  # Git commit and tag
  echo "Committing version $VERSION..."
  git add -A
  git commit -m "$VERSION"
  git tag "v$VERSION"

  # Push to GitHub
  echo "Pushing to GitHub..."
  git push
  git push origin "v$VERSION"

  # Create GitHub release with all artifacts
  echo "Creating GitHub release v$VERSION..."
  UPLOAD_FILES=("$DMG_PATH")
  [ -n "$ZIP_PATH" ] && UPLOAD_FILES+=("$ZIP_PATH")
  [ -f "$YML_PATH" ] && UPLOAD_FILES+=("$YML_PATH")

  gh release create "v$VERSION" \
    "${UPLOAD_FILES[@]}" \
    --title "v$VERSION" --notes "$(sed -n "/^## v$VERSION$/,/^## v/{/^## v$VERSION$/d;/^## v/d;p;}" CHANGELOG.md)"
fi

echo ""
echo "Release v$VERSION published successfully!"
echo "https://github.com/vinhtnk/messenger/releases/tag/v$VERSION"
