const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Load .env file
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
      process.env[key.trim()] = value.trim();
    }
  });
}

// Read package.json to get version
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = packageJson.version;
const tag = `v${version}`;

// Read CHANGELOG.md
const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');

// Extract release notes for current version
const versionRegex = new RegExp(`## ${tag}\\n([\\s\\S]*?)(?=\\n## v|$)`);
const match = changelog.match(versionRegex);

if (match && match[1]) {
  const releaseNotes = match[1].trim();
  console.log(`Updating release ${tag} with notes:\n${releaseNotes}`);

  // Write notes to temp file to avoid shell escaping issues
  const tempFile = path.join(__dirname, '..', '.release-notes-temp.md');
  fs.writeFileSync(tempFile, releaseNotes);

  // Update GitHub release with notes
  try {
    execSync(`gh release edit ${tag} --notes-file "${tempFile}"`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env }
    });
    console.log(`Successfully updated release ${tag}`);
  } catch (error) {
    console.error('Failed to update release notes:', error.message);
  } finally {
    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
} else {
  console.log(`No release notes found for ${tag} in CHANGELOG.md`);
}
