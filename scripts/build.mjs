import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
// copy testharness code to build
copyFile('web-platform-tests', 'resources/testharness.js');
copyFile('web-platform-tests', 'resources/testharnessreport.js');
// Copy package.json
copyFile('.', 'package.json');

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