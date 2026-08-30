#!/usr/bin/env node
/**
 * Verifies manifest.json is well-formed and that every file it points at exists.
 *
 *   node tools/check-manifest.js
 *
 * Chrome reports a missing icon or script as a vague load failure, so this catches
 * the common renamed-a-file mistake before you find out at chrome://extensions.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const errors = [];

function must(condition, message) {
  if (!condition) errors.push(message);
}

function mustExist(relative, where) {
  if (!relative) return;
  if (!fs.existsSync(path.join(ROOT, relative))) errors.push(`${where}: missing file "${relative}"`);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
} catch (err) {
  console.error(`manifest.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

must(manifest.manifest_version === 3, 'manifest_version must be 3');
must(!!manifest.name, 'name is required');
must(/^\d+(\.\d+){0,3}$/.test(manifest.version || ''), `version "${manifest.version}" is not a valid Chrome version string`);

mustExist(manifest.background && manifest.background.service_worker, 'background.service_worker');
must(
  !manifest.background || manifest.background.type === 'module',
  'background.type must be "module" (src/background.js uses ES imports)'
);

mustExist(manifest.options_page, 'options_page');
mustExist(manifest.action && manifest.action.default_popup, 'action.default_popup');

for (const [size, file] of Object.entries(manifest.icons || {})) mustExist(file, `icons.${size}`);
for (const [size, file] of Object.entries((manifest.action && manifest.action.default_icon) || {})) {
  mustExist(file, `action.default_icon.${size}`);
}

for (const script of manifest.content_scripts || []) {
  for (const file of script.js || []) mustExist(file, 'content_scripts.js');
  for (const file of script.css || []) mustExist(file, 'content_scripts.css');
}

// The collector is injected at runtime rather than declared, so it is not covered above.
for (const file of ['src/parse.js', 'src/collector.js']) {
  mustExist(file, 'runtime-injected script');
}

must(
  (manifest.host_permissions || []).length > 0,
  'host_permissions is empty; the collector cannot reach Amazon'
);

if (errors.length) {
  console.error('manifest.json problems:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`manifest.json OK (${manifest.name} ${manifest.version})`);
