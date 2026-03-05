#!/usr/bin/env node
/**
 * Browser Comparison Tool
 * 
 * Compares page behavior between Chrome/Safari (no protection) and DDG browser.
 * Requires ddgdriver to be running for DDG comparison.
 * 
 * Usage:
 *   node scripts/compare-browsers.mjs <url>
 *   node scripts/compare-browsers.mjs <url> --all         # Full comparison
 *   node scripts/compare-browsers.mjs <url> --trackers    # Focus on tracker blocking
 *   node scripts/compare-browsers.mjs <url> --elements    # Compare DOM elements
 *   node scripts/compare-browsers.mjs <url> --requests    # Compare network requests
 *   node scripts/compare-browsers.mjs <url> --json        # Output as JSON
 *   node scripts/compare-browsers.mjs <url> --safari      # Use Safari instead of Chrome
 *   node scripts/compare-browsers.mjs <url> --safari-only # Safari only (no DDG)
 * 
 * Environment:
 *   WEBDRIVER_SERVER_URL: DDG driver URL (default: http://localhost:4444)
 */

import { createRequire } from 'node:module';
import { debugScripts } from './debug-utils.mjs';

const localRequire = createRequire(import.meta.url);
/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');
const chrome = localRequire('selenium-webdriver/chrome');
const safari = localRequire('selenium-webdriver/safari');

// Parse args
const args = process.argv.slice(2);
const url = args.find(arg => !arg.startsWith('--')) || 'https://duckduckgo.com';
const compareAll = args.includes('--all');
const compareTrackers = args.includes('--trackers') || compareAll;
const compareElements = args.includes('--elements') || compareAll;
const compareRequests = args.includes('--requests') || compareAll;
const outputJson = args.includes('--json');
const ddgOnly = args.includes('--ddg-only');
const chromeOnly = args.includes('--chrome-only');
const useSafari = args.includes('--safari') || args.includes('--safari-only');
const safariOnly = args.includes('--safari-only');

const ddgServerUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

// Known tracker domains for testing
const TRACKER_URLS = [
    'https://www.google-analytics.com/analytics.js',
    'https://www.googletagmanager.com/gtag/js',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://static.hotjar.com/c/hotjar.js',
    'https://cdn.segment.com/analytics.js/v1/segment/analytics.min.js'
];

const results = {
    url,
    timestamp: new Date().toISOString(),
    chrome: null,
    safari: null,
    ddg: null,
    comparison: {
        pageState: {},
        elements: {},
        trackers: {},
        differences: []
    }
};

const baselineBrowser = useSafari ? 'safari' : 'chrome';

async function runChrome() {
    const options = new chrome.Options();
    options.addArguments('--headless=new');
    options.addArguments('--window-size=1280,1024');
    options.addArguments('--disable-gpu');
    options.addArguments('--no-sandbox');

    const driver = await new selenium.Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .build();

    try {
        await driver.get(url);
        await driver.sleep(2000);

        const data = {
            browser: 'chrome',
            pageState: await driver.executeScript(`return (function() { ${debugScripts.pageState} })()`),
            elements: await driver.executeScript(`return (function() { ${debugScripts.actionableElements} })()`),
            links: await driver.executeScript(`return (function() { ${debugScripts.linkAnalysis} })()`),
            inputs: await driver.executeScript(`return (function() { ${debugScripts.formInputs} })()`),
            modals: await driver.executeScript(`return (function() { ${debugScripts.detectModals} })()`),
            errors: await driver.executeScript(`return (function() { ${debugScripts.getResourceErrors} })()`)
        };

        // Test tracker requests if requested
        if (compareTrackers) {
            data.trackers = {};
            for (const trackerUrl of TRACKER_URLS) {
                const result = await driver.executeScript(`
                    return new Promise(resolve => {
                        const xhr = new XMLHttpRequest();
                        xhr.open('HEAD', '${trackerUrl}', true);
                        xhr.timeout = 5000;
                        xhr.onload = () => resolve({ blocked: false, status: xhr.status });
                        xhr.onerror = () => resolve({ blocked: true, error: 'network' });
                        xhr.ontimeout = () => resolve({ blocked: true, error: 'timeout' });
                        try { xhr.send(); } catch(e) { resolve({ blocked: true, error: e.message }); }
                    });
                `);
                data.trackers[trackerUrl] = result;
            }
        }

        return data;
    } finally {
        await driver.quit();
    }
}

async function runSafari() {
    const options = new safari.Options();

    let driver;
    try {
        driver = await new selenium.Builder()
            .forBrowser('safari')
            .setSafariOptions(options)
            .build();
    } catch (err) {
        if (err.message.includes('safaridriver')) {
            throw new Error('Safari WebDriver not enabled. Run: sudo safaridriver --enable');
        }
        throw err;
    }

    try {
        await driver.get(url);
        await driver.sleep(2000);

        const data = {
            browser: 'safari',
            pageState: await driver.executeScript(`return (function() { ${debugScripts.pageState} })()`),
            elements: await driver.executeScript(`return (function() { ${debugScripts.actionableElements} })()`),
            links: await driver.executeScript(`return (function() { ${debugScripts.linkAnalysis} })()`),
            inputs: await driver.executeScript(`return (function() { ${debugScripts.formInputs} })()`),
            modals: await driver.executeScript(`return (function() { ${debugScripts.detectModals} })()`),
            errors: await driver.executeScript(`return (function() { ${debugScripts.getResourceErrors} })()`)
        };

        // Test tracker requests if requested
        if (compareTrackers) {
            data.trackers = {};
            for (const trackerUrl of TRACKER_URLS) {
                const result = await driver.executeScript(`
                    return new Promise(resolve => {
                        const xhr = new XMLHttpRequest();
                        xhr.open('HEAD', '${trackerUrl}', true);
                        xhr.timeout = 5000;
                        xhr.onload = () => resolve({ blocked: false, status: xhr.status });
                        xhr.onerror = () => resolve({ blocked: true, error: 'network' });
                        xhr.ontimeout = () => resolve({ blocked: true, error: 'timeout' });
                        try { xhr.send(); } catch(e) { resolve({ blocked: true, error: e.message }); }
                    });
                `);
                data.trackers[trackerUrl] = result;
            }
        }

        return data;
    } finally {
        await driver.quit();
    }
}

async function runDDG() {
    // Check if DDG driver is running
    try {
        const response = await fetch(`${ddgServerUrl}/status`);
        if (!response.ok) throw new Error('Driver not ready');
    } catch {
        throw new Error(`DDG driver not running at ${ddgServerUrl}. Start with: npm run driver:ios or driver:macos`);
    }

    // Check for existing session or create new one
    const sessionsResponse = await fetch(`${ddgServerUrl}/sessions`);
    const sessionsData = await sessionsResponse.json();
    const sessions = sessionsData.value || [];
    
    let sessionId;
    let ownSession = false;

    if (sessions.length > 0) {
        sessionId = sessions[0].id;
    } else {
        // Create new session
        const createResponse = await fetch(`${ddgServerUrl}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ capabilities: {} })
        });
        const createData = await createResponse.json();
        sessionId = createData.value?.sessionId || createData.sessionId;
        ownSession = true;
    }

    async function executeScript(script) {
        const response = await fetch(`${ddgServerUrl}/session/${sessionId}/execute/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                script: `return (function() { ${script} })()`,
                args: []
            })
        });
        const data = await response.json();
        if (data.value?.error) throw new Error(data.value.message);
        return data.value;
    }

    async function executeAsyncScript(script) {
        const response = await fetch(`${ddgServerUrl}/session/${sessionId}/execute/async`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                script,
                args: []
            })
        });
        const data = await response.json();
        if (data.value?.error) throw new Error(data.value.message);
        return data.value;
    }

    try {
        // Navigate to URL
        await fetch(`${ddgServerUrl}/session/${sessionId}/url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        
        // Wait for page load
        await new Promise(r => setTimeout(r, 3000));

        const data = {
            browser: 'ddg',
            pageState: await executeScript(debugScripts.pageState),
            elements: await executeScript(debugScripts.actionableElements),
            links: await executeScript(debugScripts.linkAnalysis),
            inputs: await executeScript(debugScripts.formInputs),
            modals: await executeScript(debugScripts.detectModals),
            errors: await executeScript(debugScripts.getResourceErrors)
        };

        // Test tracker requests if requested
        if (compareTrackers) {
            data.trackers = {};
            for (const trackerUrl of TRACKER_URLS) {
                const result = await executeAsyncScript(`
                    const done = arguments[arguments.length - 1];
                    const xhr = new XMLHttpRequest();
                    xhr.open('HEAD', '${trackerUrl}', true);
                    xhr.timeout = 5000;
                    xhr.onload = () => done({ blocked: false, status: xhr.status });
                    xhr.onerror = () => done({ blocked: true, error: 'network' });
                    xhr.ontimeout = () => done({ blocked: true, error: 'timeout' });
                    try { xhr.send(); } catch(e) { done({ blocked: true, error: e.message }); }
                `);
                data.trackers[trackerUrl] = result;
            }
        }

        return data;
    } finally {
        // Clean up session if we created it
        if (ownSession) {
            await fetch(`${ddgServerUrl}/session/${sessionId}`, { method: 'DELETE' });
        }
    }
}

function compareBrowserResults(baselineData, ddgData, baselineName) {
    const comparison = {
        pageState: {},
        elements: {},
        trackers: {},
        differences: []
    };

    // Compare page state
    if (baselineData.pageState.title !== ddgData.pageState.title) {
        comparison.differences.push({
            type: 'title',
            [baselineName]: baselineData.pageState.title,
            ddg: ddgData.pageState.title
        });
    }

    // Compare element counts
    const baselineButtons = baselineData.elements?.filter(e => e.tag !== 'a').length || 0;
    const ddgButtons = ddgData.elements?.filter(e => e.tag !== 'a').length || 0;
    const baselineLinks = baselineData.elements?.filter(e => e.tag === 'a').length || 0;
    const ddgLinks = ddgData.elements?.filter(e => e.tag === 'a').length || 0;

    comparison.elements = {
        [baselineName]: { buttons: baselineButtons, links: baselineLinks },
        ddg: { buttons: ddgButtons, links: ddgLinks }
    };

    if (Math.abs(baselineButtons - ddgButtons) > 5) {
        comparison.differences.push({
            type: 'element_count',
            description: `Button count differs significantly`,
            [baselineName]: baselineButtons,
            ddg: ddgButtons
        });
    }

    // Compare tracker blocking
    if (compareTrackers && baselineData.trackers && ddgData.trackers) {
        for (const trackerUrl of Object.keys(baselineData.trackers)) {
            const baselineResult = baselineData.trackers[trackerUrl];
            const ddgResult = ddgData.trackers[trackerUrl];
            
            comparison.trackers[trackerUrl] = {
                [baselineName]: baselineResult,
                ddg: ddgResult,
                ddgBlocked: ddgResult.blocked && !baselineResult.blocked
            };

            if (ddgResult.blocked && !baselineResult.blocked) {
                comparison.differences.push({
                    type: 'tracker_blocked',
                    url: trackerUrl,
                    description: `DDG blocked tracker that ${baselineName} allowed`
                });
            }
        }
    }

    // Compare resource errors
    const baselineErrors = baselineData.errors?.errors?.length || 0;
    const ddgErrors = ddgData.errors?.errors?.length || 0;

    if (ddgErrors > baselineErrors) {
        comparison.differences.push({
            type: 'resource_errors',
            description: `DDG has more resource errors (likely blocked trackers)`,
            [baselineName]: baselineErrors,
            ddg: ddgErrors
        });
    }

    // Compare modals
    const baselineModals = baselineData.modals?.modals?.length || 0;
    const ddgModals = ddgData.modals?.modals?.length || 0;

    if (baselineModals !== ddgModals) {
        comparison.differences.push({
            type: 'modals',
            description: `Modal count differs`,
            [baselineName]: baselineModals,
            ddg: ddgModals
        });
    }

    return comparison;
}

async function main() {
    const baselineOnly = chromeOnly || safariOnly;
    const comparisonDesc = baselineOnly 
        ? `${baselineBrowser} only` 
        : ddgOnly 
            ? 'DDG only' 
            : `${baselineBrowser} vs DDG`;

    if (!outputJson) {
        console.log('🔄 Browser Comparison Tool');
        console.log(`   URL: ${url}`);
        console.log(`   Comparing: ${comparisonDesc}\n`);
    }

    try {
        // Run baseline browser (Chrome or Safari)
        if (!ddgOnly) {
            if (useSafari) {
                if (!outputJson) console.log('🧭 Running Safari...');
                results.safari = await runSafari();
                if (!outputJson) console.log('   ✓ Safari complete\n');
            } else {
                if (!outputJson) console.log('🌐 Running Chrome (headless)...');
                results.chrome = await runChrome();
                if (!outputJson) console.log('   ✓ Chrome complete\n');
            }
        }

        // Run DDG
        if (!baselineOnly) {
            if (!outputJson) console.log('🦆 Running DDG browser...');
            results.ddg = await runDDG();
            if (!outputJson) console.log('   ✓ DDG complete\n');
        }

        // Compare results
        const baselineData = useSafari ? results.safari : results.chrome;
        if (baselineData && results.ddg) {
            results.comparison = compareBrowserResults(baselineData, results.ddg, baselineBrowser);
        }

        if (outputJson) {
            console.log(JSON.stringify(results, null, 2));
        } else {
            // Print summary
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 COMPARISON SUMMARY');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            // Page info
            const baselineResult = useSafari ? results.safari : results.chrome;
            if (baselineResult) {
                console.log(`${baselineBrowser.charAt(0).toUpperCase() + baselineBrowser.slice(1)}:`);
                console.log(`   Title: ${baselineResult.pageState.title}`);
                console.log(`   Elements: ${baselineResult.elements?.length || 0}`);
            }
            
            if (results.ddg) {
                console.log('\nDDG:');
                console.log(`   Title: ${results.ddg.pageState.title}`);
                console.log(`   Elements: ${results.ddg.elements?.length || 0}`);
            }

            // Tracker comparison
            if (compareTrackers && results.comparison.trackers && Object.keys(results.comparison.trackers).length > 0) {
                console.log('\n🛡️ Tracker Blocking:');
                for (const [trackerUrl, result] of Object.entries(results.comparison.trackers)) {
                    const domain = new URL(trackerUrl).hostname;
                    const baselineResult = result[baselineBrowser];
                    const baselineIcon = baselineResult?.blocked ? '❌' : '✅';
                    const ddgIcon = result.ddg?.blocked ? '🛡️' : '⚠️';
                    console.log(`   ${domain}`);
                    console.log(`     ${baselineBrowser}: ${baselineIcon} ${baselineResult?.blocked ? 'blocked' : 'allowed'}`);
                    if (result.ddg) {
                        console.log(`     DDG:    ${ddgIcon} ${result.ddg.blocked ? 'blocked' : 'allowed'}`);
                    }
                }
            }

            // Differences
            if (results.comparison.differences.length > 0) {
                console.log('\n⚠️ Differences Found:');
                results.comparison.differences.forEach(diff => {
                    console.log(`   • ${diff.type}: ${diff.description || ''}`);
                    if (diff[baselineBrowser] !== undefined) {
                        console.log(`     ${baselineBrowser}: ${diff[baselineBrowser]}`);
                        console.log(`     DDG: ${diff.ddg}`);
                    }
                });
            } else if (baselineResult && results.ddg) {
                console.log('\n✅ No significant differences found');
            }

            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

    } catch (err) {
        if (outputJson) {
            console.log(JSON.stringify({ error: err.message }, null, 2));
        } else {
            console.error('❌ Error:', err.message);
        }
        process.exit(1);
    }
}

main();
