const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

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

  // Update GitHub release with notes
  try {
    execSync(`gh release edit ${tag} --notes "${releaseNotes.replace(/"/g, '\\"')}"`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    console.log(`Successfully updated release ${tag}`);
  } catch (error) {
    console.error('Failed to update release notes:', error.message);
  }
} else {
  console.log(`No release notes found for ${tag} in CHANGELOG.md`);
}
