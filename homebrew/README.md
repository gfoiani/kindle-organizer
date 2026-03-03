# Homebrew Cask: Kindle Organizer

This directory contains a [Homebrew Cask](https://docs.brew.sh/Cask-Cookbook) formula for installing Kindle Organizer on macOS.

## For users

```bash
# Add the tap
brew tap gfoiani/kindle-organizer

# Install
brew install --cask kindle-organizer
```

## For maintainers

After each release, you can use the provided script to automatically extract the newly built application version, calculate the SHA-256 hash, and update the `Casks/kindle-organizer.rb` file.

From the root `app` directory, run:

```bash
# This searches for the latest .dmg file in the release/ folder and uses the local homebrew folder
npm run update-homebrew
```

You can also pass explicit paths for the DMG file and the homebrew repository target:

```bash
npm run update-homebrew /path/to/Custom-Kindle-Organizer.dmg /path/to/homebrew-repo
```

Alternatively, you can configure these paths using a `.env` file in the root `app` directory:

```env
DMG_FILE=/path/to/Custom-Kindle-Organizer.dmg
HOMEBREW_DIR=/path/to/homebrew-repo
```

Then commit and push the updated files to the `homebrew-kindle-organizer` tap repository.
