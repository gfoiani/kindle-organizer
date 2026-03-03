cask "kindle-organizer" do
  version "0.1.1"
  sha256 "a5e1121771e2206df9d5966b5cb593dbf6761dfbb53362a1a90fead55207c9bf"

  url "https://github.com/gfoiani/kindle-organizer/releases/download/v#{version}/Kindle.Organizer-#{version}-universal.dmg"
  name "Kindle Organizer"
  desc "Manage and organize your Kindle library"
  homepage "https://github.com/gfoiani/kindle-organizer"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Kindle Organizer.app"

  zap trash: [
    "~/Library/Application Support/kindle-manager",
    "~/Library/Preferences/com.kindleorganizer.app.plist",
    "~/Library/Caches/com.kindleorganizer.app",
  ]
end
