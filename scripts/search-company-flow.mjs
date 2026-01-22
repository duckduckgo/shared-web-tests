import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const localRequire = createRequire(import.meta.url);

/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');
const { By } = selenium;

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep') || !args.includes('--no-keep');
const takeScreenshot = args.includes('--screenshot');
const url = args.find((arg) => !arg.startsWith('--')) ?? 'https://www.search-company.site/';

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';
const expectedPlatform = process.env.PLATFORM || process.env.TARGET_PLATFORM;

// Save a screenshot to file
async function saveScreenshot(driver, filename) {
    const screenshotsDir = join(scriptsDir, '..', 'screenshots');
    try {
        await mkdir(screenshotsDir, { recursive: true });
        const screenshotBase64 = await driver.takeScreenshot();
        const screenshotBuffer = Buffer.from(screenshotBase64, 'base64');
        const filepath = join(screenshotsDir, filename);
        await writeFile(filepath, screenshotBuffer);
        console.log(`📸 Screenshot saved: ${filepath}`);
        return filepath;
    } catch (e) {
        console.error('❌ Failed to take screenshot:', e.message);
        return null;
    }
}

// Helper to clean up any existing sessions
async function cleanupExistingSessions() {
    try {
        const response = await fetch(`${serverUrl}/sessions`);
        if (response.ok) {
            const data = await response.json();
            const sessions = data.value || (Array.isArray(data) ? data : []);
            if (Array.isArray(sessions) && sessions.length > 0) {
                console.log(`Found ${sessions.length} existing session(s), cleaning up...`);
                for (const session of sessions) {
                    try {
                        const sessionId = session.id || session.sessionId || session;
                        await fetch(`${serverUrl}/session/${sessionId}`, { method: 'DELETE' });
                        console.log(`  Deleted session: ${sessionId}`);
                    } catch (e) {
                        // Ignore errors during cleanup
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
    } catch (e) {
        // Server might not be running or might not support /sessions endpoint
    }
}

// Fill out the checkout form
async function fillCheckoutForm(driver) {
    console.log('\n📝 Filling out checkout form...');

    const fields = [
        { id: 'cc-name', value: 'John Test', label: 'Cardholder Name' },
        { id: 'cc-number', value: '4111111111111111', label: 'Card Number' },
        { id: 'cc-exp-month', value: '12', label: 'Expiry Month' },
        { id: 'cc-exp-year', value: '2028', label: 'Expiry Year' },
        { id: 'cc-csc', value: '123', label: 'CSC' },
    ];

    for (const field of fields) {
        try {
            const input = await driver.findElement(By.id(field.id));
            await input.clear();
            await input.sendKeys(field.value);
            console.log(`   ✓ ${field.label}: ${field.value}`);
        } catch (e) {
            console.warn(`   ✗ Failed to fill ${field.label}:`, e.message);
        }
    }

    // Click the Pay button
    try {
        const payButton = await driver.findElement(By.id('pay-button'));
        console.log('   Clicking Pay button...');
        await payButton.click();
        await waitForPageReady(driver);
        const newUrl = await driver.getCurrentUrl();
        console.log(`   ✓ Form submitted! Now at: ${newUrl}`);
        return true;
    } catch (e) {
        console.warn('   ✗ Failed to submit form:', e.message);
        return false;
    }
}

// Wait for page to be ready (document.readyState === 'complete')
async function waitForPageReady(driver, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const readyState = await driver.executeScript('return document.readyState');
            if (readyState === 'complete') {
                // Small extra wait for dynamic JS content
                await new Promise((resolve) => setTimeout(resolve, 1000));
                return true;
            }
        } catch (e) {
            // Script execution failed, wait and retry
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    console.warn('Page ready timeout');
    return false;
}

// Find all link elements on the page
async function findLinks(driver) {
    const clickables = [];

    try {
        const links = await driver.findElements(By.css('a[href]'));

        for (const link of links) {
            try {
                const href = await link.getAttribute('href');
                const text = await link.getText();

                // Filter out javascript: and # links
                if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                    clickables.push({ element: link, type: 'link', href, text: text || href });
                }
            } catch (e) {
                // Element became stale, skip it
            }
        }
    } catch (e) {
        console.warn('Error finding links:', e.message);
    }

    return clickables;
}

// Click through pages until completion
async function clickThroughFlow(driver, startUrl) {
    const visitedUrls = new Set();
    const maxPages = 20; // Safety limit
    let currentUrl = startUrl;
    let pageCount = 0;

    console.log(`\nStarting flow from: ${startUrl}\n`);

    while (pageCount < maxPages) {
        pageCount++;
        console.log(`\nPage ${pageCount}: ${currentUrl}`);

        // Navigate to current URL
        try {
            await driver.get(currentUrl);
            await waitForPageReady(driver);
        } catch (e) {
            console.error(`Failed to load ${currentUrl}:`, e.message);
            break;
        }

        // Get current URL after navigation (may have changed)
        try {
            currentUrl = await driver.getCurrentUrl();
            visitedUrls.add(currentUrl);
        } catch (e) {
            console.error('Failed to get current URL:', e.message);
            break;
        }

        // Get page title
        try {
            const title = await driver.getTitle();
            console.log(`   Title: ${title}`);
        } catch (e) {
            // Ignore title errors
        }

        // Find links on the page
        const links = await findLinks(driver);
        console.log(`   Found ${links.length} link(s)`);

        if (links.length === 0) {
            console.log('No links found. Flow complete!');
            break;
        }

        // List available links
        for (const link of links) {
            console.log(`     - ${link.text || '(no text)'}: ${link.href}`);
        }

        // Find a link that leads to a new page (not already visited)
        let clicked = false;
        for (const link of links) {
            try {
                const targetUrl = new URL(link.href, currentUrl).href;
                const normalizedTarget = targetUrl.split('#')[0];
                const normalizedCurrent = currentUrl.split('#')[0];

                if (normalizedTarget !== normalizedCurrent && !visitedUrls.has(normalizedTarget)) {
                    console.log(`   Clicking: "${link.text || link.href}"`);

                    // Check for target="_blank" which opens in new tab
                    let linkTarget = null;
                    try {
                        linkTarget = await link.element.getAttribute('target');
                    } catch (e) {
                        // Ignore attribute errors
                    }

                    if (linkTarget === '_blank') {
                        // Navigate directly instead of clicking (new tab links won't work)
                        console.log(`   (target="_blank" detected, navigating directly)`);
                        await driver.get(targetUrl);
                    } else {
                        await link.element.click();
                    }
                    await waitForPageReady(driver);

                    // Verify navigation
                    const newUrl = await driver.getCurrentUrl();
                    const normalizedNew = newUrl.split('#')[0];
                    if (normalizedNew !== normalizedCurrent) {
                        currentUrl = newUrl;
                        visitedUrls.add(normalizedNew);
                        clicked = true;
                        console.log(`   Navigated to: ${currentUrl}`);
                        break;
                    }
                }
            } catch (e) {
                console.warn(`   Failed to click "${link.text}":`, e.message);
                continue;
            }
        }

        if (!clicked) {
            // Check if we're on checkout page and should fill the form
            if (currentUrl.includes('checkout')) {
                const formFilled = await fillCheckoutForm(driver);
                if (formFilled) {
                    // Update current URL after form submission
                    currentUrl = await driver.getCurrentUrl();
                    visitedUrls.add(currentUrl.split('#')[0]);
                }
            }
            console.log('No new pages to visit. Flow complete!');
            break;
        }
    }

    if (pageCount >= maxPages) {
        console.log(`\nReached maximum page limit (${maxPages}). Stopping.`);
    }

    console.log(`\nSummary:`);
    console.log(`   Pages visited: ${visitedUrls.size}`);
    console.log(`   URLs:`);
    Array.from(visitedUrls).forEach((url, idx) => {
        console.log(`     ${idx + 1}. ${url}`);
    });
}

await cleanupExistingSessions();

let driver;
try {
    driver = await new selenium.Builder().usingServer(serverUrl).withCapabilities({ browserName: 'duckduckgo' }).build();

    if (expectedPlatform === 'macos') {
        try {
            const automationCheck = await fetch('http://localhost:8788/getUrl');
            if (!automationCheck.ok) {
                console.warn('⚠️  Warning: Expected macOS but automation server (port 8788) is not responding.');
                console.warn('   Make sure you ran: npm run driver:macos');
            }
        } catch (e) {
            console.warn('⚠️  Warning: Expected macOS but automation server (port 8788) is not accessible.');
            console.warn('   Make sure you ran: npm run driver:macos (not driver:ios)');
        }
    }

    await clickThroughFlow(driver, url);

    // Take screenshot at end of flow
    if (takeScreenshot) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveScreenshot(driver, `search-company-final-${timestamp}.png`);
    }

    if (keepOpen) {
        console.log('\n✅ Browser will stay open. Press Ctrl+C to quit.');
        await new Promise(() => {});
    } else {
        console.log('\n⚠️  Browser will close automatically. Use --keep to keep it open.');
    }
} catch (error) {
    console.error('Error:', error.message);
    if (error.message.includes('Session is already started') || error.message.includes('SessionNotCreatedError')) {
        console.error('\n💡 Tip: There may be an existing session. Try one of these:');
        console.error('   Option 1 - Restart the driver:');
        console.error('     1. Stop the WebDriver server (Ctrl+C in the driver terminal)');
        console.error('     2. Restart it with: npm run driver:macos (or driver:ios)');
        console.error('     3. Run this command again');
    }
    process.exit(1);
} finally {
    if (driver && !keepOpen) {
        try {
            await driver.quit();
        } catch (e) {
            // Ignore errors during quit
        }
    }
}
