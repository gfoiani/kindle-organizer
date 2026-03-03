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

After each release, update the `version` and `sha256` in `Casks/kindle-organizer.rb`:

```bash
# Get the SHA-256 of the new DMG
shasum -a 256 Kindle\ Organizer-*.dmg
```

Then commit and push to the `homebrew-kindle-organizer` tap repository.
