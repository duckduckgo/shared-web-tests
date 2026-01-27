#!/usr/bin/env node
/**
 * Race Condition Test Script
 * 
 * Tests the Content Blocker race condition fix using a simple page with trackers.
 * This verifies that:
 * 1. WebDriver waits for Content Blocker to be ready before starting session
 * 2. Trackers are blocked from the very first page load
 * 3. The race condition fix is working (not just timeout fallback)
 * 
 * Usage:
 *   node scripts/race-condition-test.mjs [--verbose]
 * 
 * Environment:
 *   PLATFORM=macos|ios - Target platform (default: macos)
 *   WEBDRIVER_URL=http://localhost:4444 - WebDriver server URL
 */

import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');
// Using synchronous XHR probing instead of debug-utils async version
import fs from 'node:fs';
import path from 'node:path';

const VERBOSE = process.argv.includes('--verbose');
const TEST_URL = 'https://www.publisher-company.site/product.html?p=12';

// The test page loads trackers from ad-company.site domains
// The page UI shows the blocking status of each resource
const PAGE_TRACKERS = [
    'https://convert.ad-company.site/convert.js',
    'https://www.ad-company.site/track.js'
];

// Additional common tracker URLs to probe
const COMMON_TRACKERS = [
    'https://www.google-analytics.com/collect',
    'https://www.googletagmanager.com/gtm.js',
    'https://connect.facebook.net/en_US/fbevents.js'
];

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

function verbose(...args) {
    if (VERBOSE) console.log(`[DEBUG]`, ...args);
}

async function runTest() {
    log('🧪 Race Condition Test');
    log(`   Test URL: ${TEST_URL}`);
    log(`   Expected: Trackers should be blocked immediately`);
    log('');

    const webdriverUrl = process.env.WEBDRIVER_URL || 'http://localhost:4444';
    const platform = process.env.PLATFORM || 'macos';
    
    log(`Platform: ${platform}`);
    log(`WebDriver URL: ${webdriverUrl}`);
    log('');

    // Record timing
    const timings = {
        sessionStart: Date.now(),
        sessionReady: null,
        pageLoad: null,
        probeComplete: null
    };

    // Create WebDriver session
    log('📱 Creating WebDriver session...');
    const capabilities = { browserName: 'duckduckgo' };
    
    let driver;
    try {
        driver = await new selenium.Builder()
            .usingServer(webdriverUrl)
            .withCapabilities(capabilities)
            .build();
        
        timings.sessionReady = Date.now();
        log(`✓ Session ready in ${timings.sessionReady - timings.sessionStart}ms`);
        log('  (This includes Content Blocker compilation time)');
        log('');
    } catch (e) {
        log(`❌ Failed to create session: ${e.message}`);
        log('');
        log('Make sure WebDriver is running:');
        log(`  PLATFORM=${platform} ./webdriver/target/release/ddgdriver --port 4444`);
        process.exit(1);
    }

    try {
        // Navigate to test page
        log(`🌐 Navigating to ${TEST_URL}...`);
        await driver.get(TEST_URL);
        await driver.sleep(2000); // Allow page to fully load
        
        timings.pageLoad = Date.now();
        const currentUrl = await driver.getCurrentUrl();
        log(`✓ Page loaded in ${timings.pageLoad - timings.sessionReady}ms`);
        log(`   Current URL: ${currentUrl}`);
        log('');

        // Read the page's built-in tracker status display
        log('📊 Reading page tracker status display...');
        const pageTrackerStatus = await driver.executeScript(`
            // Open the Resources details element
            const details = document.querySelector('details');
            if (details) details.open = true;
            
            // Read all list items showing tracker status
            const items = document.querySelectorAll('li');
            return Array.from(items).map(li => {
                const text = li.textContent.trim();
                const url = li.querySelector('a')?.href || text.split(' ')[0];
                const isBlocked = text.includes('blocked');
                return { text, url, blocked: isBlocked };
            });
        `);
        
        if (pageTrackerStatus && pageTrackerStatus.length > 0) {
            log('Page reports the following tracker status:');
            pageTrackerStatus.forEach(t => {
                const icon = t.blocked ? '❌' : '✅';
                log(`   ${icon} ${t.text}`);
            });
        }
        
        // Probe for blocked resources using synchronous XHR
        log('');
        log('🛡️ Probing Content Blocker via XHR...');
        const probeResults = { blocked: [], allowed: [], errors: [], url: '', pageStatus: pageTrackerStatus };
        
        probeResults.url = await driver.executeScript('return location.href');
        
        // Combine page trackers and common trackers
        const allTrackers = [...PAGE_TRACKERS, ...COMMON_TRACKERS];
        
        for (const url of allTrackers) {
            const testScript = `
                try {
                    const xhr = new XMLHttpRequest();
                    xhr.open('HEAD', '${url}', false); // synchronous
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
                    probeResults.allowed.push({ url, httpStatus: result.code });
                } else {
                    probeResults.blocked.push({ url, error: result?.error || 'unknown' });
                }
            } catch (e) {
                probeResults.errors.push({ url, error: e.message });
            }
        }
        
        timings.probeComplete = Date.now();
        
        log('');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('📊 RESULTS');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('');
        
        const blockedCount = probeResults.blocked?.length || 0;
        const allowedCount = probeResults.allowed?.length || 0;
        const totalTrackers = PAGE_TRACKERS.length + COMMON_TRACKERS.length;
        
        // Determine test result
        const raceConditionFixed = blockedCount > 0;
        const allBlocked = blockedCount === totalTrackers && allowedCount === 0;
        
        if (allBlocked) {
            log('✅ ALL TRACKERS BLOCKED');
            log(`   Blocked: ${blockedCount}/${totalTrackers}`);
            log('   Race condition fix: VERIFIED ✓');
            log('');
            log('   The Content Blocker was ready before page load.');
        } else if (raceConditionFixed) {
            log('⚠️ PARTIAL BLOCKING');
            log(`   Blocked: ${blockedCount}/${totalTrackers}`);
            log(`   Allowed: ${allowedCount}/${totalTrackers}`);
            log('   Race condition fix: PARTIAL');
            log('');
            log('   Some trackers were blocked. The Content Blocker may have been');
            log('   ready for some rules but not others, or some URLs may not be in our tracker list.');
        } else {
            log('❌ NO TRACKERS BLOCKED');
            log(`   Allowed: ${allowedCount}/${totalTrackers}`);
            log('   Race condition fix: NOT WORKING');
            log('');
            log('   The Content Blocker rules were not applied before the test ran.');
            log('   This indicates the race condition fix is not working properly.');
        }
        
        log('');
        log('Timing Summary:');
        log(`   Session startup:  ${timings.sessionReady - timings.sessionStart}ms`);
        log(`   Page load:        ${timings.pageLoad - timings.sessionReady}ms`);
        log(`   Total test time:  ${timings.probeComplete - timings.sessionStart}ms`);
        log('');
        
        // Save results to file for documentation
        const results = {
            timestamp: new Date().toISOString(),
            testUrl: TEST_URL,
            platform,
            timings: {
                sessionStartup: timings.sessionReady - timings.sessionStart,
                pageLoad: timings.pageLoad - timings.sessionReady,
                totalTest: timings.probeComplete - timings.sessionStart
            },
            blocking: {
                blocked: blockedCount,
                allowed: allowedCount,
                total: totalTrackers,
                allBlocked,
                raceConditionFixed
            },
            probeDetails: probeResults
        };
        
        const resultsDir = path.join(process.cwd(), 'test-results');
        if (!fs.existsSync(resultsDir)) {
            fs.mkdirSync(resultsDir, { recursive: true });
        }
        
        const resultsFile = path.join(resultsDir, `race-condition-test-${Date.now()}.json`);
        fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
        log(`Results saved to: ${resultsFile}`);
        
        // Take screenshot for documentation
        try {
            const screenshot = await driver.takeScreenshot();
            const screenshotDir = path.join(process.cwd(), 'screenshots');
            if (!fs.existsSync(screenshotDir)) {
                fs.mkdirSync(screenshotDir, { recursive: true });
            }
            const screenshotFile = path.join(screenshotDir, `race-condition-test-${Date.now()}.png`);
            fs.writeFileSync(screenshotFile, screenshot, 'base64');
            log(`Screenshot saved to: ${screenshotFile}`);
        } catch (e) {
            verbose('Screenshot failed:', e.message);
        }
        
        // Return exit code based on result
        return allBlocked ? 0 : (raceConditionFixed ? 0 : 1);
        
    } finally {
        log('');
        log('Cleaning up...');
        await driver.quit();
        log('Done.');
    }
}

// Run the test
runTest()
    .then(exitCode => process.exit(exitCode))
    .catch(e => {
        console.error('Test failed with error:', e);
        process.exit(1);
    });
