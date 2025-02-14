import { copyFileSync, existsSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// copy testharness code to build
copyFile('web-platform-tests', 'resources/testharness.js');
copyFile('web-platform-tests', 'resources/testharnessreport.js');
// Copy package.json
copyFile('.', 'package.json');
// Example test files
copyFile('web-platform-tests', 'referrer-policy/generic/test-case.sub.js');

[
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/context-for-location.html',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/resources/context-helper.js',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/resources/target.js',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/entry/entry.html',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/entry/target.html',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/incumbent/empty.html',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/relevant/empty.html',

  'html/browsers/windows/embedded-opener-a-form.html',
].forEach(file => copyFile('web-platform-tests', file));

[
  'wpt',
].forEach(file => copyFile('web-platform-tests', file));


// Copy whole directory
const copyDirectories = [
  'docs',
  'tools',
  'common'
];
copyDirectories.forEach(dir => {
  rmSync(`build/${dir}`, { recursive: true, force: true });
  cpSync(`web-platform-tests/${dir}`, `build/${dir}`, { recursive: true, force: true });
})

const currentDir = process.cwd() + '/build';
const config = {
  "doc_root": currentDir
}
// write a JSON file
writeFileSync('build/wpt.config.json', JSON.stringify(config, null, 2));

// Run cli command
const buildManifest = `./web-platform-tests/wpt manifest --tests-root ${currentDir} --no-download -v`;
execSync(buildManifest, { stdio: 'inherit' });

function copyFile(from, file) {
    // Get filename
    const fileParts = file.split('/');
    const filename = fileParts[fileParts.length - 1];
    const dir = fileParts.slice(0, -1).join('/');
    const buildDir = join('build', dir);
    const testharnessDest = join(buildDir, filename);
    if (!existsSync(buildDir)) {
      mkdirSync(buildDir, { recursive: true });
    }
    copyFileSync(join(from, file), testharnessDest);
}

// Apply patch file into web-platform-tests
const patchFile = '../full.patch';
execSync(`patch -p1 < ${patchFile}`, { cwd: 'build' });
