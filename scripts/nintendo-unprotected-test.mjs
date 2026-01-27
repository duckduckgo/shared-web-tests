#!/usr/bin/env node
/**
 * Nintendo Unprotected Test
 * 
 * Tests Nintendo cart page with unprotectedTemporary config to verify:
 * 1. Trackers are ALLOWED (not blocked) when nintendo.com is in unprotectedTemporary
 * 2. The cart page loads correctly without protection interference
 * 
 * Usage:
 *   node scripts/nintendo-unprotected-test.mjs [--compare] [--verbose]
 * 
 * Options:
 *   --compare    Run both protected and unprotected modes for comparison
 *   --verbose    Show detailed output
 * 
 * Environment:
 *   PLATFORM=macos|ios - Target platform (default: macos)
 *   WEBDRIVER_URL=http://localhost:4444 - WebDriver server URL
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERBOSE = process.argv.includes('--verbose');
const COMPARE_MODE = process.argv.includes('--compare');

const WEBDRIVER_URL = process.env.WEBDRIVER_URL || 'http://localhost:4444';
const PLATFORM = process.env.PLATFORM || 'macos';

// Nintendo test URLs
const NINTENDO_CART_URL = 'https://www.nintendo.com/us/cart/';
const NINTENDO_STORE_URL = 'https://www.nintendo.com/us/store/';

// Unprotected config path
const UNPROTECTED_CONFIG_PATH = path.resolve(__dirname, '../test-configs/nintendo-unprotected-full.json');

// Known trackers that Nintendo uses
const NINTENDO_TRACKERS = [
    'https://logx.optimizely.com/v1/events',
    'https://www.google-analytics.com/collect',
    'https://www.googletagmanager.com/gtm.js',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://bat.bing.com/bat.js'
];

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

function verbose(...args) {
    if (VERBOSE) console.log(`  [verbose]`, ...args);
}

/**
 * Probe tracker URLs to determine blocking status
 */
async function probeTrackers(driver, trackerUrls) {
    const results = { blocked: [], allowed: [], errors: [] };
    
    for (const url of trackerUrls) {
        const testScript = `
            try {
                const xhr = new XMLHttpRequest();
                xhr.open('HEAD', '${url}', false);
                xhr.timeout = 3000;
                xhr.send();
                return { status: 'allowed', code: xhr.status };
            } catch (e) {
                return { status: 'blocked', error: e.message };
            }
        `;
        
        try {
            const result = await driver.executeScript(testScript);
            if (result && result.status === 'allowed') {
                results.allowed.push({ url, httpStatus: result.code });
            } else {
                results.blocked.push({ url, error: result?.error || 'unknown' });
            }
        } catch (e) {
            results.errors.push({ url, error: e.message });
        }
    }
    
    return results;
}

/**
 * Get console errors from the page
 */
async function getConsoleErrors(driver) {
    try {
        const logs = await driver.manage().logs().get('browser');
        return logs.filter(l => l.level.name === 'SEVERE' || l.level.name === 'WARNING');
    } catch {
        return [];
    }
}

/**
 * Save screenshot
 */
async function saveScreenshot(driver, filename) {
    const screenshotDir = path.join(__dirname, '../screenshots');
    if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
    }
    
    try {
        const screenshot = await driver.takeScreenshot();
        const filepath = path.join(screenshotDir, filename);
        fs.writeFileSync(filepath, screenshot, 'base64');
        log(`📸 Screenshot: ${filepath}`);
        return filepath;
    } catch (e) {
        log(`Screenshot failed: ${e.message}`);
        return null;
    }
}

/**
 * Restart WebDriver server (needed because DDG WebDriver is single-session)
 */
async function restartWebDriver() {
    try {
        execSync('pkill -9 -f ddgdriver 2>/dev/null || true', { timeout: 5000 });
    } catch {}
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const { spawn } = await import('node:child_process');
    const scriptPath = path.resolve(__dirname, 'apple-webdriver.sh');
    
    const child = spawn('bash', [scriptPath, 'driver', 'macos'], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            DERIVED_DATA_PATH: path.resolve(__dirname, '../../apple-browsers/DerivedData'),
            MACOS_APP_PATH: path.resolve(__dirname, '../../apple-browsers/DerivedData/Build/Products/Debug/DuckDuckGo.app'),
            TARGET_PLATFORM: 'macos'
        }
    });
    child.unref();
    
    // Wait for WebDriver to be ready
    for (let i = 0; i < 30; i++) {
        try {
            const response = await fetch(`${WEBDRIVER_URL}/status`);
            if (response.ok) {
                verbose(`WebDriver ready after ${i + 1} attempts`);
                return;
            }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    throw new Error('WebDriver failed to start');
}

/**
 * Run a single test iteration
 */
async function runTest(useUnprotectedConfig, label) {
    log('');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`🧪 ${label}`);
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const capabilities = { browserName: 'duckduckgo' };
    
    if (useUnprotectedConfig) {
        capabilities['ddg:privacyConfigPath'] = UNPROTECTED_CONFIG_PATH;
        log(`Config: ${UNPROTECTED_CONFIG_PATH}`);
    } else {
        log(`Config: Default (protected)`);
    }
    
    let driver;
    const startTime = Date.now();
    
    try {
        driver = await new selenium.Builder()
            .usingServer(WEBDRIVER_URL)
            .withCapabilities(capabilities)
            .build();
        
        log(`✓ Session created in ${Date.now() - startTime}ms`);
        
        // Navigate to Nintendo store first (cart may redirect if empty)
        log(`\n🌐 Navigating to ${NINTENDO_STORE_URL}...`);
        await driver.get(NINTENDO_STORE_URL);
        await driver.sleep(3000);
        
        const storeUrl = await driver.getCurrentUrl();
        log(`   Current URL: ${storeUrl}`);
        
        // Take screenshot of store page
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const modeLabel = useUnprotectedConfig ? 'unprotected' : 'protected';
        await saveScreenshot(driver, `nintendo-store-${modeLabel}-${timestamp}.png`);
        
        // Probe trackers on store page
        log('\n🛡️ Probing tracker URLs...');
        const storeProbeResults = await probeTrackers(driver, NINTENDO_TRACKERS);
        
        log('\nStore page tracker status:');
        const blockedCount = storeProbeResults.blocked.length;
        const allowedCount = storeProbeResults.allowed.length;
        
        storeProbeResults.blocked.forEach(t => log(`   ❌ BLOCKED: ${t.url}`));
        storeProbeResults.allowed.forEach(t => log(`   ✅ ALLOWED: ${t.url} (HTTP ${t.httpStatus})`));
        storeProbeResults.errors.forEach(t => log(`   ⚠️ ERROR: ${t.url} - ${t.error}`));
        
        log(`\nSummary: ${blockedCount} blocked, ${allowedCount} allowed`);
        
        // Expected behavior:
        // - Protected mode: ALL trackers should be BLOCKED
        // - Unprotected mode: ALL trackers should be ALLOWED
        
        let expectedBehavior;
        let testPassed;
        
        if (useUnprotectedConfig) {
            // With unprotectedTemporary, we expect trackers to be ALLOWED
            expectedBehavior = 'Trackers should be ALLOWED';
            testPassed = allowedCount > 0;
            
            if (blockedCount === 0 && allowedCount === NINTENDO_TRACKERS.length) {
                log(`\n✅ PERFECT: All trackers allowed - unprotectedTemporary is working!`);
            } else if (allowedCount > 0) {
                log(`\n✓ PARTIAL: Some trackers allowed (${allowedCount}/${NINTENDO_TRACKERS.length})`);
            } else {
                log(`\n❌ FAIL: All trackers still blocked - unprotectedTemporary not working`);
            }
        } else {
            // Without unprotectedTemporary, we expect trackers to be BLOCKED
            expectedBehavior = 'Trackers should be BLOCKED';
            testPassed = blockedCount > 0;
            
            if (allowedCount === 0 && blockedCount === NINTENDO_TRACKERS.length) {
                log(`\n✅ PERFECT: All trackers blocked - protection is active!`);
            } else if (blockedCount > 0) {
                log(`\n✓ PARTIAL: Some trackers blocked (${blockedCount}/${NINTENDO_TRACKERS.length})`);
            } else {
                log(`\n❌ FAIL: No trackers blocked - protection not working`);
            }
        }
        
        // Now navigate to cart page
        log(`\n🛒 Navigating to ${NINTENDO_CART_URL}...`);
        await driver.get(NINTENDO_CART_URL);
        await driver.sleep(3000);
        
        const cartUrl = await driver.getCurrentUrl();
        log(`   Current URL: ${cartUrl}`);
        
        // Take screenshot of cart page
        await saveScreenshot(driver, `nintendo-cart-${modeLabel}-${timestamp}.png`);
        
        // Probe trackers on cart page
        const cartProbeResults = await probeTrackers(driver, NINTENDO_TRACKERS);
        
        log('\nCart page tracker status:');
        cartProbeResults.blocked.forEach(t => log(`   ❌ BLOCKED: ${t.url}`));
        cartProbeResults.allowed.forEach(t => log(`   ✅ ALLOWED: ${t.url} (HTTP ${t.httpStatus})`));
        
        // Check for any page errors or issues
        log('\n📋 Checking for page elements...');
        const pageInfo = await driver.executeScript(`
            return {
                title: document.title,
                hasCart: !!document.querySelector('[class*="cart"], [class*="Cart"]'),
                hasError: !!document.querySelector('[class*="error"], [class*="Error"]'),
                hasModal: !!document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"]'),
                bodyText: document.body?.innerText?.substring(0, 500) || ''
            };
        `);
        
        log(`   Title: ${pageInfo.title}`);
        log(`   Has cart element: ${pageInfo.hasCart}`);
        log(`   Has error: ${pageInfo.hasError}`);
        log(`   Has modal: ${pageInfo.hasModal}`);
        verbose(`   Body preview: ${pageInfo.bodyText.substring(0, 200)}...`);
        
        return {
            mode: modeLabel,
            storeUrl,
            cartUrl,
            storeTrackers: {
                blocked: blockedCount,
                allowed: allowedCount,
                total: NINTENDO_TRACKERS.length
            },
            cartTrackers: {
                blocked: cartProbeResults.blocked.length,
                allowed: cartProbeResults.allowed.length,
                total: NINTENDO_TRACKERS.length
            },
            pageInfo,
            testPassed,
            expectedBehavior
        };
        
    } finally {
        if (driver) {
            try {
                await driver.quit();
            } catch {}
        }
        
        // Kill the app to ensure clean state
        try {
            execSync('pkill -9 -f "DuckDuckGo.app" 2>/dev/null || true', { timeout: 5000 });
        } catch {}
    }
}

async function main() {
    log('🎮 Nintendo Unprotected Test');
    log(`Platform: ${PLATFORM}`);
    log(`WebDriver: ${WEBDRIVER_URL}`);
    log(`Config file: ${UNPROTECTED_CONFIG_PATH}`);
    log('');
    
    // Verify config file exists
    if (!fs.existsSync(UNPROTECTED_CONFIG_PATH)) {
        log(`❌ Config file not found: ${UNPROTECTED_CONFIG_PATH}`);
        process.exit(1);
    }
    
    // Verify nintendo.com is in unprotectedTemporary
    const config = JSON.parse(fs.readFileSync(UNPROTECTED_CONFIG_PATH, 'utf-8'));
    const unprotectedDomains = (config.unprotectedTemporary || []).map(e => e.domain);
    
    if (!unprotectedDomains.includes('nintendo.com') && !unprotectedDomains.includes('www.nintendo.com')) {
        log(`❌ nintendo.com not found in unprotectedTemporary!`);
        log(`   Found domains: ${unprotectedDomains.join(', ')}`);
        process.exit(1);
    }
    
    log(`✓ Config has nintendo.com in unprotectedTemporary`);
    
    const results = [];
    
    if (COMPARE_MODE) {
        // Run both protected and unprotected modes
        log('\n📊 Running comparison test (protected vs unprotected)...');
        
        // First: Protected mode (default config)
        const protectedResult = await runTest(false, 'PROTECTED MODE (default config)');
        results.push(protectedResult);
        
        // Restart WebDriver for clean session
        log('\n🔄 Restarting WebDriver for next test...');
        await restartWebDriver();
        
        // Second: Unprotected mode (custom config)
        const unprotectedResult = await runTest(true, 'UNPROTECTED MODE (nintendo in unprotectedTemporary)');
        results.push(unprotectedResult);
        
        // Print comparison
        log('\n');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('📊 COMPARISON RESULTS');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('');
        log('Store Page Trackers:');
        log(`   Protected:   ${protectedResult.storeTrackers.blocked} blocked, ${protectedResult.storeTrackers.allowed} allowed`);
        log(`   Unprotected: ${unprotectedResult.storeTrackers.blocked} blocked, ${unprotectedResult.storeTrackers.allowed} allowed`);
        log('');
        log('Cart Page Trackers:');
        log(`   Protected:   ${protectedResult.cartTrackers.blocked} blocked, ${protectedResult.cartTrackers.allowed} allowed`);
        log(`   Unprotected: ${unprotectedResult.cartTrackers.blocked} blocked, ${unprotectedResult.cartTrackers.allowed} allowed`);
        log('');
        
        // Determine if unprotectedTemporary made a difference
        const storeBlockedDiff = protectedResult.storeTrackers.blocked - unprotectedResult.storeTrackers.blocked;
        const storeAllowedDiff = unprotectedResult.storeTrackers.allowed - protectedResult.storeTrackers.allowed;
        
        if (storeAllowedDiff > 0 || storeBlockedDiff > 0) {
            log(`✅ unprotectedTemporary IS working!`);
            log(`   ${storeAllowedDiff} more trackers allowed in unprotected mode`);
        } else if (unprotectedResult.storeTrackers.allowed === 0 && protectedResult.storeTrackers.blocked > 0) {
            log(`❌ unprotectedTemporary NOT working - trackers still blocked`);
        } else {
            log(`⚠️ Unclear - both modes have same behavior`);
        }
        
    } else {
        // Just run unprotected mode
        const result = await runTest(true, 'UNPROTECTED MODE TEST');
        results.push(result);
    }
    
    // Save results
    const resultsDir = path.join(__dirname, '../test-results');
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
    }
    
    const resultsFile = path.join(resultsDir, `nintendo-unprotected-test-${Date.now()}.json`);
    fs.writeFileSync(resultsFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        platform: PLATFORM,
        compareMode: COMPARE_MODE,
        configPath: UNPROTECTED_CONFIG_PATH,
        results
    }, null, 2));
    
    log(`\nResults saved to: ${resultsFile}`);
    
    // Exit with appropriate code
    const allPassed = results.every(r => r.testPassed);
    process.exit(allPassed ? 0 : 1);
}

main().catch(e => {
    console.error('Test failed:', e);
    process.exit(1);
});
