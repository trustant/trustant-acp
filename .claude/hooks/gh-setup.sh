#!/bin/bash

# GitHub CLI (gh) auto-installer for Claude Code Web
# This script runs on SessionStart and installs gh if not present

set -e

# Only run in Claude Code Web environment
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

# Skip if gh is already installed
if command -v gh &> /dev/null; then
  exit 0
fi

echo "Installing GitHub CLI..."

# Create local bin directory
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"

# Download and install gh CLI
GH_VERSION="2.63.2"
GH_ARCHIVE="gh_${GH_VERSION}_linux_amd64.tar.gz"
GH_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_ARCHIVE}"

cd /tmp
curl -sLO "$GH_URL"
tar -xzf "$GH_ARCHIVE"
mv "gh_${GH_VERSION}_linux_amd64/bin/gh" "$LOCAL_BIN/"
rm -rf "$GH_ARCHIVE" "gh_${GH_VERSION}_linux_amd64"

# Add to PATH for current and future sessions
export PATH="$LOCAL_BIN:$PATH"

# Persist PATH setting if CLAUDE_ENV_FILE is available
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export PATH=\"$LOCAL_BIN:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# Verify installation
if gh --version &> /dev/null; then
  echo "GitHub CLI installed successfully: $(gh --version | head -1)"
else
  echo "Failed to install GitHub CLI" >&2
  exit 1
fi
