#!/usr/bin/env node
/**
 * Unprotected Config Test
 * 
 * Tests with ddg:privacyConfigPath set to unprotected-all.json
 * to verify that:
 * 1. The config is being applied
 * 2. Trackers ARE allowed when unprotected
 * 
 * If trackers are still blocked, the config injection race condition isn't fixed.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '../test-configs/unprotected-all.json');

const TEST_URL = 'https://www.publisher-company.site/product.html?p=12';

console.log('🧪 Unprotected Config Test');
console.log(`   URL: ${TEST_URL}`);
console.log(`   Config: ${configPath}`);
console.log('');

const capabilities = {
    browserName: 'duckduckgo',
    'ddg:privacyConfigPath': configPath
};

console.log('📱 Creating WebDriver session with unprotected config...');
const startTime = Date.now();

const driver = await new selenium.Builder()
    .usingServer('http://localhost:4444')
    .withCapabilities(capabilities)
    .build();

const sessionTime = Date.now() - startTime;
console.log(`✓ Session ready in ${sessionTime}ms`);
console.log('');

try {
    console.log(`🌐 Navigating to ${TEST_URL}...`);
    await driver.get(TEST_URL);
    await driver.sleep(3000);
    
    const currentUrl = await driver.getCurrentUrl();
    console.log(`✓ Page loaded: ${currentUrl}`);
    console.log('');
    
    // Read the page's tracker status display
    const pageStatus = await driver.executeScript(`
        const details = document.querySelector('details');
        if (details) details.open = true;
        const items = document.querySelectorAll('li');
        return Array.from(items).map(li => li.textContent.trim());
    `);
    
    console.log('📊 Page tracker status display:');
    if (pageStatus && pageStatus.length > 0) {
        pageStatus.forEach(s => console.log('  ', s));
    } else {
        console.log('   (no status items - trackers may have loaded successfully)');
    }
    
    // Probe trackers
    console.log('');
    console.log('🔍 XHR Probe:');
    const trackers = [
        'https://convert.ad-company.site/convert.js',
        'https://www.ad-company.site/track.js'
    ];
    
    let blockedCount = 0;
    let allowedCount = 0;
    
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
        
        if (r.status === 'allowed') allowedCount++;
        else blockedCount++;
    }
    
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    if (allowedCount === trackers.length) {
        console.log('✅ CONFIG INJECTION WORKING');
        console.log('   All trackers allowed with unprotected config.');
        console.log('   Race condition fix verified for config injection.');
    } else if (blockedCount === trackers.length) {
        console.log('❌ CONFIG INJECTION NOT WORKING');
        console.log('   Trackers still blocked despite unprotected config.');
        console.log('   The TEST_PRIVACY_CONFIG_PATH is not being applied.');
        console.log('');
        console.log('   Possible causes:');
        console.log('   - Content Blocker compiled from bundled config before custom config loaded');
        console.log('   - trackerAllowlist not being processed correctly');
        console.log('   - Config cache still being used');
    } else {
        console.log('⚠️ PARTIAL RESULT');
        console.log(`   Blocked: ${blockedCount}, Allowed: ${allowedCount}`);
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
} finally {
    console.log('');
    console.log('Cleaning up...');
    await driver.quit();
    console.log('Done.');
}
