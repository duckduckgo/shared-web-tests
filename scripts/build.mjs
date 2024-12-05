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

// Edit product list to contain our browser
// tools/wptrunner/wptrunner/browsers/__init__.py
const browserName = 'duckduckgo';
const browserClassName = 'DuckDuckGoBrowser';
// Get file contents:
const browsersFile = 'build/tools/wptrunner/wptrunner/browsers/__init__.py';
let browsersFileContents = readFileSync(browsersFile, 'utf8');
// Replace the content
browsersFileContents = browsersFileContents.replace(/"android_webview",/g, `"android_webview",\n"${browserName}",`);
// Validate that the content was replaced
if (!browsersFileContents.includes(browserName)) {
  throw new Error('Browser name was not added to the list of browsers');
}
// Write the file
writeFileSync(browsersFile, browsersFileContents);

// Modify run.py to use our browser
const runFile = 'build/tools/wpt/run.py';
let runFileContents = readFileSync(runFile, 'utf8');
// Replace the content
runFileContents = runFileContents.replace(/"android_webview": AndroidWebview,/g, `"android_webview": AndroidWebview, "${browserName}": ${browserClassName},`);
// Validate that the content was replaced
if (!runFileContents.includes(browserName)) {
  throw new Error('Browser name was not added to the list of browsers');
}
// Write the file
writeFileSync(runFile, runFileContents);



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