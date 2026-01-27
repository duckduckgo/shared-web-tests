#!/usr/bin/env node
/**
 * Chrome Control Test (No Content Blocking)
 * 
 * Runs the tracker test in Chrome to verify:
 * 1. Trackers ARE loaded in a browser without content blocking
 * 2. The page correctly reports tracker status
 * 
 * This validates the DDG race condition test isn't giving false positives.
 */

import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');
const chrome = localRequire('selenium-webdriver/chrome');

const TEST_URL = 'https://www.publisher-company.site/product.html?p=12';

console.log('🧪 Chrome Control Test (No Content Blocking)');
console.log(`   URL: ${TEST_URL}`);
console.log('');

const options = new chrome.Options();
options.addArguments('--headless=new');

const driver = await new selenium.Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();

try {
    await driver.get(TEST_URL);
    await driver.sleep(3000);
    
    console.log('URL:', await driver.getCurrentUrl());
    
    // Read the page's tracker status
    const status = await driver.executeScript(`
        const details = document.querySelector('details');
        if (details) details.open = true;
        const items = document.querySelectorAll('li');
        return Array.from(items).map(li => li.textContent.trim());
    `);
    
    console.log('');
    console.log('📊 Page tracker status (Chrome, no blocking):');
    if (status && status.length > 0) {
        status.forEach(s => console.log('  ', s));
    } else {
        console.log('   (no status items found)');
    }
    
    // Probe trackers
    console.log('');
    console.log('🔍 XHR Probe:');
    const trackers = [
        'https://convert.ad-company.site/convert.js',
        'https://www.ad-company.site/track.js'
    ];
    
    for (const url of trackers) {
        const r = await driver.executeScript(`
            try {
                const xhr = new XMLHttpRequest();
                xhr.open('HEAD', '${url}', false);
                xhr.send();
                return { status: 'allowed', code: xhr.status };
            } catch (e) {
                return { status: 'blocked', error: e.message };
            }
        `);
        const icon = r.status === 'allowed' ? '✅' : '❌';
        console.log(`  ${icon} ${url}: ${r.status}${r.code ? ' (HTTP '+r.code+')' : ''}`);
    }
    
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Expected: Trackers should be ALLOWED in Chrome (no Content Blocker)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
} finally {
    await driver.quit();
}
console.log('');
console.log('Done');
