import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
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