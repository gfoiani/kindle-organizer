import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

// Load .env file
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, '..');

// Get parameters from CLI or .env
let dmgFile = process.argv[2] || process.env.DMG_FILE;
// Defaults to the sibling tap repo (gfoiani/homebrew-kindle-organizer) checked
// out next to the app, i.e. ../homebrew. Override with HOMEBREW_DIR or argv[3].
let homebrewDir = process.argv[3] || process.env.HOMEBREW_DIR || '../homebrew';

// Default DMG file to the auto-discovered one in release/
if (!dmgFile) {
  try {
    const releaseDir = join(appRoot, 'release');
    if (existsSync(releaseDir)) {
      const files = execSync(`find "${releaseDir}" -maxdepth 1 -name "*.dmg" | head -n 1`).toString().trim();
      if (files) dmgFile = files;
    }
  } catch (error) {
    console.warn('Warning: Could not automatically find DMG file in release folder.');
  }
}

if (!dmgFile || !existsSync(dmgFile)) {
  console.error(`Error: No DMG file found at '${dmgFile || 'release/*.dmg'}'.`);
  console.error('Usage: yarn update-homebrew [path/to/app.dmg] [path/to/homebrew_dir]');
  console.error('Or set DMG_FILE and HOMEBREW_DIR in your .env file.');
  process.exit(1);
}

// Resolve paths to absolute if relative
dmgFile = resolve(appRoot, dmgFile);
homebrewDir = resolve(appRoot, homebrewDir);

console.log(`Using DMG file: ${dmgFile}`);
console.log(`Using Homebrew directory: ${homebrewDir}`);

// Extract version from package.json
let version;
try {
  const packageJson = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf-8'));
  version = packageJson.version;
} catch (error) {
  console.error('Error: Could not read or parse package.json');
  process.exit(1);
}

if (!version) {
  console.error('Error: Could not extract version from package.json');
  process.exit(1);
}

console.log(`Version: ${version}`);

// Calculate SHA256 of the DMG file
console.log(`Calculating SHA256 of ${dmgFile}...`);
let sha256;
try {
  const shasumOutput = execSync(`shasum -a 256 "${dmgFile}"`).toString().trim();
  sha256 = shasumOutput.split(' ')[0];
} catch (error) {
  console.error(`Error calculating SHA256 for ${dmgFile}:`, error);
  process.exit(1);
}

console.log(`SHA256: ${sha256}`);

// Ensure homebrew directories exist
if (!existsSync(homebrewDir)) {
  mkdirSync(homebrewDir, { recursive: true });
}

// Update the Cask file automatically
const casksDir = join(homebrewDir, 'Casks');
if (!existsSync(casksDir)) {
  mkdirSync(casksDir, { recursive: true });
}

const caskFile = join(casksDir, 'kindle-organizer.rb');
if (existsSync(caskFile)) {
  console.log(`Updating ${caskFile}...`);
  try {
    let caskContent = readFileSync(caskFile, 'utf-8');

    // Update version
    caskContent = caskContent.replace(/^[ \t]*version.*/m, `  version "${version}"`);
    // Update sha256
    caskContent = caskContent.replace(/^[ \t]*sha256.*/m, `  sha256 "${sha256}"`);

    writeFileSync(caskFile, caskContent);
    console.log(`Successfully updated ${caskFile}`);
  } catch (error) {
    // Abort the release pipeline on a failed cask write so release.mts never
    // commits/pushes a stale cask.
    console.error(`Error updating Cask file at ${caskFile}:`, error);
    process.exit(1);
  }
} else {
  console.warn(`Warning: Cask file not found at ${caskFile}.`);
  console.log('Please update your Homebrew Cask file manually with:');
  console.log(`  version "${version}"`);
  console.log(`  sha256 "${sha256}"`);
}

console.log('Done!');
