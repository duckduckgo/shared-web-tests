/**
 * Site Diagnostic Mode
 * 
 * Crawls and explores a site randomly using debug tools.
 * Captures selectors clicked, console logs, DOM changes, and screenshots.
 * 
 * Usage:
 *   npm run diagnose -- https://example.com
 *   npm run diagnose -- https://example.com --max-clicks 20 --screenshot
 * 
 * Options:
 *   --max-clicks N    Maximum number of clicks (default: 15)
 *   --max-depth N     Maximum navigation depth (default: 3)
 *   --screenshot      Take screenshots after each click
 *   --stay-on-domain  Only follow links on the same domain (default: true)
 *   --no-stay-on-domain  Allow navigation to external domains
 *   --keep            Keep browser open after completion
 *   --report FILE     Save report to file (default: stdout)
 */

import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    runDebug,
    startConsoleCapture,
    getConsoleLogs,
    trackDomChanges
} from './debug-utils.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const localRequire = createRequire(import.meta.url);

/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');

// Parse CLI arguments
const args = process.argv.slice(2);
const url = args.find((arg) => !arg.startsWith('--')) ?? 'https://duckduckgo.com';
const maxClicks = parseInt(args.find((_, i, a) => a[i - 1] === '--max-clicks') ?? '15', 10);
const maxDepth = parseInt(args.find((_, i, a) => a[i - 1] === '--max-depth') ?? '3', 10);
const takeScreenshots = args.includes('--screenshot');
const stayOnDomain = !args.includes('--no-stay-on-domain');
const keepOpen = args.includes('--keep');
const reportFile = args.find((_, i, a) => a[i - 1] === '--report');

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

/**
 * @typedef {Object} ClickRecord
 * @property {string} selector - CSS selector of clicked element
 * @property {string} text - Text content of element
 * @property {string} tag - HTML tag name
 * @property {string} url - URL where click happened
 * @property {string} [targetUrl] - URL navigated to (if any)
 * @property {number} timestamp - Unix timestamp
 * @property {Object} domChanges - DOM mutations after click
 * @property {Array} consoleLogs - Console logs during click
 * @property {string} [screenshotPath] - Path to screenshot (if taken)
 */

/**
 * @typedef {Object} DiagnosticReport
 * @property {string} startUrl - Starting URL
 * @property {string} startTime - ISO timestamp
 * @property {string} endTime - ISO timestamp
 * @property {number} duration - Duration in ms
 * @property {Array<ClickRecord>} clicks - All clicks performed
 * @property {Set<string>} visitedUrls - All URLs visited
 * @property {Object} summary - Summary statistics
 */

/** @type {DiagnosticReport} */
const report = {
    startUrl: url,
    startTime: new Date().toISOString(),
    endTime: '',
    duration: 0,
    clicks: [],
    visitedUrls: new Set(),
    summary: {
        totalClicks: 0,
        successfulClicks: 0,
        failedClicks: 0,
        pagesVisited: 0,
        errorsLogged: 0,
        warningsLogged: 0,
        modalsEncountered: 0
    }
};

// Save screenshot
async function saveScreenshot(driver, name) {
    const screenshotsDir = join(scriptsDir, '..', 'screenshots', 'diagnose');
    try {
        await mkdir(screenshotsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${name}-${timestamp}.png`;
        const screenshotBase64 = await driver.takeScreenshot();
        const screenshotBuffer = Buffer.from(screenshotBase64, 'base64');
        const filepath = join(screenshotsDir, filename);
        await writeFile(filepath, screenshotBuffer);
        return filepath;
    } catch (e) {
        console.error('Failed to save screenshot:', e.message);
        return null;
    }
}

// Wait for page to be ready
async function waitForPageReady(driver, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const readyState = await driver.executeScript('return document.readyState');
            if (readyState === 'complete') {
                await new Promise((resolve) => setTimeout(resolve, 500));
                return true;
            }
        } catch (e) {
            // Retry
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
}

// Check if URL is on same domain
function isSameDomain(baseUrl, targetUrl) {
    try {
        const base = new URL(baseUrl);
        const target = new URL(targetUrl, baseUrl);
        return base.hostname === target.hostname;
    } catch {
        return false;
    }
}

// Select a random element to click
function selectRandomElement(elements, visitedSelectors) {
    // Prefer elements we haven't clicked yet
    const unclicked = elements.filter(e => !visitedSelectors.has(e.selector));
    const pool = unclicked.length > 0 ? unclicked : elements;
    
    if (pool.length === 0) return null;
    
    // Weight selection towards elements with click handlers and visible text
    const weighted = pool.map(e => ({
        ...e,
        weight: (e.hasClickHandler ? 3 : 1) * (e.text ? 2 : 1) * (e.tag === 'a' ? 2 : 1)
    }));
    
    const totalWeight = weighted.reduce((sum, e) => sum + e.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const element of weighted) {
        random -= element.weight;
        if (random <= 0) return element;
    }
    
    return weighted[0];
}

// Main diagnostic crawl
async function diagnose(driver, startUrl) {
    const visitedSelectors = new Set();
    let currentUrl = startUrl;
    let clickCount = 0;
    let depth = 0;
    const startTime = Date.now();

    console.log(`\n🔍 Starting site diagnosis: ${startUrl}`);
    console.log(`   Max clicks: ${maxClicks}, Max depth: ${maxDepth}`);
    console.log(`   Stay on domain: ${stayOnDomain}\n`);

    // Navigate to start URL
    await driver.get(startUrl);
    await waitForPageReady(driver);
    report.visitedUrls.add(startUrl);

    // Start console capture for the session
    await startConsoleCapture(driver);

    while (clickCount < maxClicks) {
        currentUrl = await driver.getCurrentUrl();
        
        console.log(`\n📍 Page ${report.visitedUrls.size}: ${currentUrl}`);

        // Get page state
        const pageState = await runDebug(driver, 'pageState');
        console.log(`   Title: ${pageState.title}`);

        // Check for modals
        const modalCheck = await runDebug(driver, 'detectModals');
        if (modalCheck.hasModal) {
            console.log(`   ⚠️ Modal detected: ${modalCheck.modals.length} modal(s)`);
            report.summary.modalsEncountered++;
            
            // Try to close modal by clicking close button or backdrop
            for (const modal of modalCheck.modals) {
                if (modal.hasCloseButton) {
                    try {
                        await driver.executeScript(`
                            const closeBtn = document.querySelector('[aria-label*="close"], [aria-label*="Close"], .close, [class*="close"]');
                            if (closeBtn) closeBtn.click();
                        `);
                        console.log('   Attempted to close modal');
                        await new Promise((resolve) => setTimeout(resolve, 500));
                    } catch (e) {
                        // Ignore
                    }
                }
            }
        }

        // Get all actionable elements
        const elements = await runDebug(driver, 'actionableElements');
        console.log(`   Found ${elements.length} actionable element(s)`);

        if (elements.length === 0) {
            console.log('   No elements to click, trying to go back...');
            try {
                await driver.navigate().back();
                await waitForPageReady(driver);
                depth = Math.max(0, depth - 1);
            } catch {
                console.log('   Cannot go back, stopping');
                break;
            }
            continue;
        }

        // Filter elements based on domain constraint
        let candidates = elements;
        if (stayOnDomain) {
            candidates = elements.filter(e => {
                if (e.tag !== 'a' || !e.href) return true;
                return isSameDomain(startUrl, e.href);
            });
        }

        if (candidates.length === 0) {
            console.log('   No valid candidates (all external), stopping');
            break;
        }

        // Select random element
        const target = selectRandomElement(candidates, visitedSelectors);
        if (!target) {
            console.log('   No element selected, stopping');
            break;
        }

        visitedSelectors.add(target.selector);
        clickCount++;

        console.log(`\n🖱️ Click ${clickCount}: [${target.selector}] "${target.text?.substring(0, 40) || '(no text)'}"`);
        if (target.href) {
            console.log(`   Target: ${target.href}`);
        }

        // Record click
        /** @type {ClickRecord} */
        const clickRecord = {
            selector: target.selector,
            text: target.text || '',
            tag: target.tag,
            url: currentUrl,
            timestamp: Date.now(),
            domChanges: { added: [], removed: [], attributes: [] },
            consoleLogs: []
        };

        // Clear console logs before click
        await runDebug(driver, 'clearConsoleLogs');

        // Track DOM changes during click
        try {
            const domChanges = await trackDomChanges(driver, async () => {
                // Execute click via JavaScript (more reliable than WebDriver click)
                await driver.executeScript(`
                    const el = document.querySelector(arguments[0]);
                    if (el) {
                        el.scrollIntoView({ behavior: 'instant', block: 'center' });
                        el.click();
                    }
                `, target.selector);
            });
            clickRecord.domChanges = domChanges;
            
            if (domChanges.added?.length > 0) {
                console.log(`   DOM: +${domChanges.added.length} elements`);
            }
        } catch (e) {
            console.log(`   Click error: ${e.message}`);
            report.summary.failedClicks++;
        }

        // Wait for any navigation/async effects
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await waitForPageReady(driver);

        // Get console logs from click
        const logs = await getConsoleLogs(driver, false);
        clickRecord.consoleLogs = logs.logs || [];
        
        const errors = clickRecord.consoleLogs.filter(l => ['error', 'exception', 'rejection'].includes(l.level));
        const warnings = clickRecord.consoleLogs.filter(l => l.level === 'warn');
        
        if (errors.length > 0) {
            console.log(`   ❌ ${errors.length} error(s) during click`);
            errors.slice(0, 2).forEach(e => console.log(`      ${e.message.substring(0, 60)}`));
            report.summary.errorsLogged += errors.length;
        }
        if (warnings.length > 0) {
            report.summary.warningsLogged += warnings.length;
        }

        // Check if URL changed
        const newUrl = await driver.getCurrentUrl();
        if (newUrl !== currentUrl) {
            clickRecord.targetUrl = newUrl;
            console.log(`   → Navigated to: ${newUrl}`);
            
            if (!report.visitedUrls.has(newUrl)) {
                report.visitedUrls.add(newUrl);
                depth++;
            }
            
            if (depth > maxDepth) {
                console.log(`   Max depth reached, going back...`);
                await driver.navigate().back();
                await waitForPageReady(driver);
                depth--;
            }
        }

        // Take screenshot if enabled
        if (takeScreenshots) {
            const screenshotPath = await saveScreenshot(driver, `click-${clickCount}`);
            clickRecord.screenshotPath = screenshotPath;
            if (screenshotPath) {
                console.log(`   📸 ${screenshotPath}`);
            }
        }

        report.clicks.push(clickRecord);
        report.summary.successfulClicks++;
    }

    // Finalize report
    report.endTime = new Date().toISOString();
    report.duration = Date.now() - startTime;
    report.summary.totalClicks = clickCount;
    report.summary.pagesVisited = report.visitedUrls.size;

    // Get final console logs
    const finalLogs = await getConsoleLogs(driver, true);
    
    return report;
}

// Print report summary
function printReport(report) {
    console.log('\n' + '='.repeat(60));
    console.log('📊 DIAGNOSTIC REPORT');
    console.log('='.repeat(60));
    
    console.log(`\nSite: ${report.startUrl}`);
    console.log(`Duration: ${(report.duration / 1000).toFixed(1)}s`);
    console.log(`Started: ${report.startTime}`);
    console.log(`Ended: ${report.endTime}`);
    
    console.log(`\n📈 Summary:`);
    console.log(`   Total clicks: ${report.summary.totalClicks}`);
    console.log(`   Successful: ${report.summary.successfulClicks}`);
    console.log(`   Failed: ${report.summary.failedClicks}`);
    console.log(`   Pages visited: ${report.summary.pagesVisited}`);
    console.log(`   Errors logged: ${report.summary.errorsLogged}`);
    console.log(`   Warnings logged: ${report.summary.warningsLogged}`);
    console.log(`   Modals encountered: ${report.summary.modalsEncountered}`);
    
    console.log(`\n🔗 URLs Visited:`);
    Array.from(report.visitedUrls).forEach((url, i) => {
        console.log(`   ${i + 1}. ${url}`);
    });
    
    console.log(`\n🖱️ Click Log:`);
    report.clicks.forEach((click, i) => {
        const nav = click.targetUrl ? ` → ${click.targetUrl}` : '';
        const errors = click.consoleLogs.filter(l => ['error', 'exception'].includes(l.level)).length;
        const errStr = errors > 0 ? ` ❌${errors}` : '';
        console.log(`   ${i + 1}. [${click.selector}] "${click.text.substring(0, 30)}"${nav}${errStr}`);
    });
    
    // Identify potential issues
    const issues = [];
    if (report.summary.errorsLogged > 0) {
        issues.push(`${report.summary.errorsLogged} JavaScript errors detected`);
    }
    if (report.summary.failedClicks > 0) {
        issues.push(`${report.summary.failedClicks} clicks failed`);
    }
    if (report.summary.modalsEncountered > 0) {
        issues.push(`${report.summary.modalsEncountered} modals blocked interaction`);
    }
    
    if (issues.length > 0) {
        console.log(`\n⚠️ Potential Issues:`);
        issues.forEach(issue => console.log(`   - ${issue}`));
    } else {
        console.log(`\n✅ No obvious issues detected`);
    }
    
    console.log('\n' + '='.repeat(60));
}

// Save report to file
async function saveReport(report, filepath) {
    const serializable = {
        ...report,
        visitedUrls: Array.from(report.visitedUrls)
    };
    await writeFile(filepath, JSON.stringify(serializable, null, 2));
    console.log(`\n💾 Report saved to: ${filepath}`);
}

// Cleanup existing sessions
async function cleanupExistingSessions() {
    try {
        const response = await fetch(`${serverUrl}/sessions`);
        if (response.ok) {
            const data = await response.json();
            const sessions = data.value || [];
            for (const session of sessions) {
                try {
                    const sessionId = session.id || session.sessionId || session;
                    await fetch(`${serverUrl}/session/${sessionId}`, { method: 'DELETE' });
                } catch {
                    // Ignore
                }
            }
        }
    } catch {
        // Server not running
    }
}

// Main
await cleanupExistingSessions();

let driver;
try {
    driver = await new selenium.Builder()
        .usingServer(serverUrl)
        .withCapabilities({ browserName: 'duckduckgo' })
        .build();

    const finalReport = await diagnose(driver, url);
    printReport(finalReport);

    if (reportFile) {
        await saveReport(finalReport, reportFile);
    }

    if (keepOpen) {
        console.log('\n✅ Browser staying open. Press Ctrl+C to quit.');
        await new Promise(() => {});
    }
} catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
} finally {
    if (driver && !keepOpen) {
        try {
            await driver.quit();
        } catch {
            // Ignore
        }
    }
}
