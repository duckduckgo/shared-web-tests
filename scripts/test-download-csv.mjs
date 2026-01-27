#!/usr/bin/env node
/**
 * Test CSV Download across browsers
 * 
 * Tests the programmatic download at:
 * https://privacy-test-pages.site/features/download/download-csv.html
 * 
 * Usage:
 *   node scripts/test-download-csv.mjs --chrome    # Test in Chrome
 *   node scripts/test-download-csv.mjs --safari    # Test in Safari  
 *   node scripts/test-download-csv.mjs --ddg       # Test in DDG (requires driver running)
 *   node scripts/test-download-csv.mjs --all       # Test all browsers
 */

import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);
/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');
const chrome = localRequire('selenium-webdriver/chrome');
const safari = localRequire('selenium-webdriver/safari');

const TEST_URL = 'https://privacy-test-pages.site/features/download/download-csv.html';
const DDG_SERVER_URL = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

// Parse args
const args = process.argv.slice(2);
const testChrome = args.includes('--chrome') || args.includes('--all');
const testSafari = args.includes('--safari') || args.includes('--all');
const testDDG = args.includes('--ddg') || args.includes('--all');

// Script to inject that monitors download attempts
const downloadMonitorScript = `
    return (function() {
        const result = {
            anchorCreated: false,
            anchorClicked: false,
            blobUrlCreated: false,
            downloadAttribute: null,
            blobUrl: null,
            errors: [],
            consoleMessages: []
        };
        
        // Capture console
        const origLog = console.log;
        const origError = console.error;
        const origWarn = console.warn;
        console.log = (...args) => { result.consoleMessages.push({level: 'log', msg: args.join(' ')}); origLog(...args); };
        console.error = (...args) => { result.consoleMessages.push({level: 'error', msg: args.join(' ')}); origError(...args); };
        console.warn = (...args) => { result.consoleMessages.push({level: 'warn', msg: args.join(' ')}); origWarn(...args); };
        
        // Intercept anchor creation
        const origCreateElement = document.createElement.bind(document);
        document.createElement = function(tagName) {
            const el = origCreateElement(tagName);
            if (tagName.toLowerCase() === 'a') {
                result.anchorCreated = true;
                // Track when click is called
                const origClick = el.click.bind(el);
                el.click = function() {
                    result.anchorClicked = true;
                    result.downloadAttribute = el.download;
                    result.blobUrl = el.href;
                    if (el.href && el.href.startsWith('blob:')) {
                        result.blobUrlCreated = true;
                    }
                    return origClick();
                };
            }
            return el;
        };
        
        // Capture errors
        window.addEventListener('error', (e) => {
            result.errors.push({ type: 'error', message: e.message, filename: e.filename });
        });
        
        window.__downloadMonitor = result;
        return { status: 'monitoring' };
    })();
`;

const getDownloadResult = `
    return window.__downloadMonitor || { error: 'Monitor not initialized' };
`;

const clickDownloadLink = `
    const link = document.querySelector('a[href="#"]') || 
                 Array.from(document.querySelectorAll('a')).find(a => 
                     a.textContent.toLowerCase().includes('download csv'));
    if (!link) {
        return { error: 'Download link not found' };
    }
    link.click();
    return { clicked: true, linkText: link.textContent.trim() };
`;

async function testChromeDownload() {
    console.log('\n🌐 CHROME TEST');
    console.log('=' .repeat(50));
    
    const options = new chrome.Options();
    options.addArguments('--headless=new');
    options.addArguments('--window-size=1280,1024');
    options.addArguments('--disable-gpu');
    options.addArguments('--no-sandbox');
    // Enable downloads in headless mode
    options.setUserPreferences({
        'download.prompt_for_download': false,
        'download.default_directory': '/tmp/chrome-downloads'
    });

    const driver = await new selenium.Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .build();

    try {
        console.log(`  Navigating to: ${TEST_URL}`);
        await driver.get(TEST_URL);
        await driver.sleep(1000);
        
        // Get page title
        const title = await driver.getTitle();
        console.log(`  Page title: ${title}`);
        
        // Inject download monitor
        console.log('  Setting up download monitor...');
        await driver.executeScript(downloadMonitorScript);
        
        // Click the download link
        console.log('  Clicking download link...');
        const clickResult = await driver.executeScript(clickDownloadLink);
        console.log(`  Click result: ${JSON.stringify(clickResult)}`);
        
        // Wait for any async operations
        await driver.sleep(1000);
        
        // Get download monitor results
        const downloadResult = await driver.executeScript(getDownloadResult);
        console.log('\n  📊 Download Monitor Results:');
        console.log(`     Anchor created: ${downloadResult.anchorCreated}`);
        console.log(`     Anchor clicked: ${downloadResult.anchorClicked}`);
        console.log(`     Blob URL created: ${downloadResult.blobUrlCreated}`);
        console.log(`     Download attribute: ${downloadResult.downloadAttribute}`);
        console.log(`     Blob URL: ${downloadResult.blobUrl ? downloadResult.blobUrl.substring(0, 50) + '...' : 'none'}`);
        
        if (downloadResult.errors.length > 0) {
            console.log(`\n  ❌ Errors:`);
            downloadResult.errors.forEach(e => console.log(`     - ${e.message}`));
        }
        
        if (downloadResult.consoleMessages.length > 0) {
            console.log(`\n  📋 Console messages:`);
            downloadResult.consoleMessages.forEach(m => console.log(`     [${m.level}] ${m.msg}`));
        }
        
        // Check if download actually worked
        const downloadSuccess = downloadResult.anchorCreated && 
                               downloadResult.anchorClicked && 
                               downloadResult.blobUrlCreated;
        
        console.log(`\n  ${downloadSuccess ? '✅' : '❌'} Chrome Download: ${downloadSuccess ? 'SUCCESS' : 'FAILED'}`);
        
        return { browser: 'chrome', success: downloadSuccess, details: downloadResult };
        
    } finally {
        await driver.quit();
    }
}

async function testSafariDownload() {
    console.log('\n🧭 SAFARI TEST');
    console.log('=' .repeat(50));
    
    const options = new safari.Options();
    
    let driver;
    try {
        driver = await new selenium.Builder()
            .forBrowser('safari')
            .setSafariOptions(options)
            .build();
    } catch (err) {
        if (err.message.includes('safaridriver')) {
            console.log('  ❌ Safari WebDriver not enabled.');
            console.log('     Run: sudo safaridriver --enable');
            return { browser: 'safari', success: false, error: 'WebDriver not enabled' };
        }
        throw err;
    }

    try {
        console.log(`  Navigating to: ${TEST_URL}`);
        await driver.get(TEST_URL);
        await driver.sleep(1000);
        
        // Get page title
        const title = await driver.getTitle();
        console.log(`  Page title: ${title}`);
        
        // Inject download monitor
        console.log('  Setting up download monitor...');
        await driver.executeScript(downloadMonitorScript);
        
        // Click the download link
        console.log('  Clicking download link...');
        const clickResult = await driver.executeScript(clickDownloadLink);
        console.log(`  Click result: ${JSON.stringify(clickResult)}`);
        
        // Wait for any async operations
        await driver.sleep(1000);
        
        // Get download monitor results
        const downloadResult = await driver.executeScript(getDownloadResult);
        console.log('\n  📊 Download Monitor Results:');
        console.log(`     Anchor created: ${downloadResult.anchorCreated}`);
        console.log(`     Anchor clicked: ${downloadResult.anchorClicked}`);
        console.log(`     Blob URL created: ${downloadResult.blobUrlCreated}`);
        console.log(`     Download attribute: ${downloadResult.downloadAttribute}`);
        console.log(`     Blob URL: ${downloadResult.blobUrl ? downloadResult.blobUrl.substring(0, 50) + '...' : 'none'}`);
        
        if (downloadResult.errors.length > 0) {
            console.log(`\n  ❌ Errors:`);
            downloadResult.errors.forEach(e => console.log(`     - ${e.message}`));
        }
        
        if (downloadResult.consoleMessages.length > 0) {
            console.log(`\n  📋 Console messages:`);
            downloadResult.consoleMessages.forEach(m => console.log(`     [${m.level}] ${m.msg}`));
        }
        
        // Check if download actually worked
        const downloadSuccess = downloadResult.anchorCreated && 
                               downloadResult.anchorClicked && 
                               downloadResult.blobUrlCreated;
        
        console.log(`\n  ${downloadSuccess ? '✅' : '❌'} Safari Download: ${downloadSuccess ? 'SUCCESS' : 'FAILED'}`);
        
        return { browser: 'safari', success: downloadSuccess, details: downloadResult };
        
    } finally {
        await driver.quit();
    }
}

async function testDDGDownload() {
    console.log('\n🦆 DDG BROWSER TEST');
    console.log('=' .repeat(50));
    
    // Check if DDG driver is running
    try {
        const response = await fetch(`${DDG_SERVER_URL}/status`);
        if (!response.ok) throw new Error('Driver not ready');
    } catch {
        console.log(`  ❌ DDG driver not running at ${DDG_SERVER_URL}`);
        console.log('     Start with: npm run driver:macos');
        return { browser: 'ddg', success: false, error: 'Driver not running' };
    }

    // Get or create session
    const sessionsResponse = await fetch(`${DDG_SERVER_URL}/sessions`);
    const sessionsData = await sessionsResponse.json();
    const sessions = sessionsData.value || [];
    
    let sessionId;
    let ownSession = false;

    if (sessions.length > 0) {
        sessionId = sessions[0].id;
        console.log(`  Using existing session: ${sessionId}`);
    } else {
        const createResponse = await fetch(`${DDG_SERVER_URL}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ capabilities: {} })
        });
        const createData = await createResponse.json();
        sessionId = createData.value?.sessionId || createData.sessionId;
        ownSession = true;
        console.log(`  Created new session: ${sessionId}`);
    }

    async function executeScript(script) {
        const response = await fetch(`${DDG_SERVER_URL}/session/${sessionId}/execute/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script, args: [] })
        });
        const data = await response.json();
        if (data.value?.error) throw new Error(data.value.message);
        return data.value;
    }

    try {
        console.log(`  Navigating to: ${TEST_URL}`);
        await fetch(`${DDG_SERVER_URL}/session/${sessionId}/url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: TEST_URL })
        });
        
        // Wait for page load
        await new Promise(r => setTimeout(r, 2000));
        
        // Get page title
        const titleResponse = await fetch(`${DDG_SERVER_URL}/session/${sessionId}/title`);
        const titleData = await titleResponse.json();
        console.log(`  Page title: ${titleData.value}`);
        
        // Inject download monitor
        console.log('  Setting up download monitor...');
        await executeScript(downloadMonitorScript);
        
        // Click the download link
        console.log('  Clicking download link...');
        const clickResult = await executeScript(clickDownloadLink);
        console.log(`  Click result: ${JSON.stringify(clickResult)}`);
        
        // Wait for any async operations
        await new Promise(r => setTimeout(r, 1500));
        
        // Get download monitor results
        const downloadResult = await executeScript(getDownloadResult);
        console.log('\n  📊 Download Monitor Results:');
        console.log(`     Anchor created: ${downloadResult.anchorCreated}`);
        console.log(`     Anchor clicked: ${downloadResult.anchorClicked}`);
        console.log(`     Blob URL created: ${downloadResult.blobUrlCreated}`);
        console.log(`     Download attribute: ${downloadResult.downloadAttribute}`);
        console.log(`     Blob URL: ${downloadResult.blobUrl ? downloadResult.blobUrl.substring(0, 50) + '...' : 'none'}`);
        
        if (downloadResult.errors && downloadResult.errors.length > 0) {
            console.log(`\n  ❌ Errors:`);
            downloadResult.errors.forEach(e => console.log(`     - ${e.message}`));
        }
        
        if (downloadResult.consoleMessages && downloadResult.consoleMessages.length > 0) {
            console.log(`\n  📋 Console messages:`);
            downloadResult.consoleMessages.forEach(m => console.log(`     [${m.level}] ${m.msg}`));
        }
        
        // Check if download actually worked
        const downloadSuccess = downloadResult.anchorCreated && 
                               downloadResult.anchorClicked && 
                               downloadResult.blobUrlCreated;
        
        console.log(`\n  ${downloadSuccess ? '✅' : '❌'} DDG Download: ${downloadSuccess ? 'SUCCESS' : 'FAILED'}`);
        
        return { browser: 'ddg', success: downloadSuccess, details: downloadResult };
        
    } finally {
        // Clean up session if we created it
        if (ownSession) {
            await fetch(`${DDG_SERVER_URL}/session/${sessionId}`, { method: 'DELETE' });
        }
    }
}

async function main() {
    console.log('🧪 CSV Download Test');
    console.log(`   URL: ${TEST_URL}`);
    console.log(`   Testing programmatic anchor click download\n`);
    
    const results = [];
    
    if (!testChrome && !testSafari && !testDDG) {
        console.log('No browsers selected. Use --chrome, --safari, --ddg, or --all');
        process.exit(1);
    }
    
    try {
        if (testChrome) {
            const result = await testChromeDownload();
            results.push(result);
        }
        
        if (testSafari) {
            const result = await testSafariDownload();
            results.push(result);
        }
        
        if (testDDG) {
            const result = await testDDGDownload();
            results.push(result);
        }
        
        // Summary
        console.log('\n' + '=' .repeat(50));
        console.log('📊 SUMMARY');
        console.log('=' .repeat(50));
        results.forEach(r => {
            const icon = r.success ? '✅' : '❌';
            const status = r.error || (r.success ? 'SUCCESS' : 'FAILED');
            console.log(`  ${icon} ${r.browser.toUpperCase()}: ${status}`);
        });
        
        // Detailed comparison
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;
        
        if (failCount > 0 && successCount > 0) {
            console.log('\n⚠️  BROWSER INCONSISTENCY DETECTED');
            console.log('   Some browsers handle the download differently.');
        }
        
    } catch (err) {
        console.error('\n❌ Fatal error:', err.message);
        process.exit(1);
    }
}

main();
