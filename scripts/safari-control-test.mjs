#!/usr/bin/env node
/**
 * Safari Control Test (No Content Blocking)
 * 
 * Runs the same tracker probe in Safari to verify that:
 * 1. Trackers are NOT blocked in Safari (control case)
 * 2. The publisher-company.site page correctly reports tracker status
 * 
 * This validates the race condition test isn't giving false positives.
 */

import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');

const TEST_URL = 'https://www.publisher-company.site/product.html?p=12';

// The actual trackers the page loads (visible in page UI)
const PAGE_TRACKERS = [
    'https://convert.ad-company.site/convert.js',
    'https://www.ad-company.site/track.js'
];

console.log('🧪 Safari Control Test (No Content Blocking)');
console.log(`   URL: ${TEST_URL}`);
console.log('');

const driver = await new selenium.Builder()
    .forBrowser('safari')
    .build();

try {
    await driver.get(TEST_URL);
    await driver.sleep(3000);
    
    console.log('Current URL:', await driver.getCurrentUrl());
    
    // Check what the page reports
    const pageReport = await driver.executeScript(`
        const details = document.querySelector('details');
        if (details) details.open = true;
        const items = document.querySelectorAll('li');
        return Array.from(items).map(li => li.textContent.trim());
    `);
    
    console.log('');
    console.log('📊 Page tracker status (from page UI):');
    pageReport.forEach(r => console.log('  ', r));
    
    // Probe the same trackers
    console.log('');
    console.log('🔍 Probing trackers via XHR:');
    for (const url of PAGE_TRACKERS) {
        const result = await driver.executeScript(`
            try {
                const xhr = new XMLHttpRequest();
                xhr.open('HEAD', '${url}', false);
                xhr.timeout = 3000;
                xhr.send();
                return { status: 'allowed', code: xhr.status };
            } catch (e) {
                return { status: 'blocked', error: e.message };
            }
        `);
        const statusIcon = result.status === 'allowed' ? '✅' : '❌';
        console.log(`  ${statusIcon} ${url}: ${result.status}${result.code ? ' (HTTP '+result.code+')' : ''}`);
    }
    
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Expected: Trackers should be ALLOWED in Safari (no Content Blocker)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
} finally {
    await driver.quit();
}
console.log('');
console.log('Done');
