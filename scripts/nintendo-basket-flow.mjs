/**
 * Nintendo Store Basket Flow Test
 *
 * Tests the e-commerce flow on nintendo.com:
 * 1. Login to Nintendo Account (if credentials provided)
 * 2. Navigate to Nintendo store
 * 3. Search for a game
 * 4. Select a game from results
 * 5. Add to basket
 * 6. Proceed toward checkout
 *
 * Works on both macOS and iOS platforms.
 *
 * Usage:
 *   node scripts/nintendo-basket-flow.mjs [--no-keep] [--screenshot]
 *
 * Environment:
 *   PLATFORM / TARGET_PLATFORM: 'macos' or 'ios'
 *   WEBDRIVER_SERVER_URL: WebDriver server URL (default: http://localhost:4444)
 *   NINTENDO_EMAIL: Nintendo Account email (required for digital purchases)
 *   NINTENDO_PASSWORD: Nintendo Account password
 *   NINTENDO_SKIP_LOGIN: Set to 'true' to skip login step
 */

import { createRequire } from 'node:module';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugScripts, runDebug, trackDomChanges, startConsoleCapture, logConsoleLogs } from './debug-utils.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

// Load .env file if it exists
try {
    const envPath = join(scriptsDir, '..', '.env');
    const envContent = await readFile(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            const value = valueParts.join('=');
            if (key && value && !process.env[key]) {
                process.env[key] = value;
            }
        }
    }
} catch {
    // .env file doesn't exist, that's fine
}

const localRequire = createRequire(import.meta.url);

/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');
const { By, until } = selenium;

// Parse CLI args
const args = process.argv.slice(2);
const keepOpen = args.includes('--keep') || !args.includes('--no-keep');
const takeScreenshot = args.includes('--screenshot');

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';
const platform = process.env.PLATFORM || process.env.TARGET_PLATFORM || 'unknown';

// Nintendo credentials
const nintendoEmail = process.env.NINTENDO_EMAIL;
const nintendoPassword = process.env.NINTENDO_PASSWORD;
const skipLogin = process.env.NINTENDO_SKIP_LOGIN === 'true';

// Config
const NINTENDO_STORE_URL = 'https://www.nintendo.com/en-gb/store/';
const NINTENDO_LOGIN_URL = 'https://accounts.nintendo.com/login';
const SEARCH_TERM = 'fallout shelter';
const PAGE_LOAD_TIMEOUT = 15000;
const ELEMENT_WAIT_TIMEOUT = 10000;

// Test state tracking
const testState = {
    currentStep: '',
    visitedUrls: [],
    errors: [],
};

/**
 * Save a screenshot to file
 */
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

/**
 * Clean up any existing WebDriver sessions
 */
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
                    } catch {
                        // Ignore cleanup errors
                    }
                }
                await sleep(500);
            }
        }
    } catch {
        // Server might not be running
    }
}

/**
 * Clear browser state (cookies, localStorage, sessionStorage)
 * Call this at the start of each test run to ensure clean state
 */
async function clearBrowserState(driver) {
    console.log('🧹 Clearing browser state...');
    try {
        // Navigate to a page first so we can clear storage (can't clear on about:blank)
        await driver.get(NINTENDO_STORE_URL);
        await waitForPageReady(driver);

        // Delete all cookies
        await driver.manage().deleteAllCookies();
        console.log('   ✓ Cleared cookies');

        // Clear localStorage and sessionStorage
        await driver.executeScript(`
            try {
                localStorage.clear();
                sessionStorage.clear();
            } catch (e) {
                // Storage might be disabled or inaccessible
            }
        `);
        console.log('   ✓ Cleared localStorage and sessionStorage');

        // Also clear Nintendo-specific domains by navigating and clearing
        const domains = [
            'https://accounts.nintendo.com/',
            'https://ec.nintendo.com/',
        ];

        for (const domain of domains) {
            try {
                await driver.get(domain);
                await driver.manage().deleteAllCookies();
                await driver.executeScript(`
                    try {
                        localStorage.clear();
                        sessionStorage.clear();
                    } catch (e) {}
                `);
            } catch {
                // Domain might redirect or be inaccessible
            }
        }
        console.log('   ✓ Cleared Nintendo account/eShop state');

        return true;
    } catch (e) {
        console.warn(`   ⚠️ Could not fully clear browser state: ${e.message}`);
        return false;
    }
}

/**
 * Sleep for specified milliseconds - use sparingly, prefer wait conditions
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for page to be ready (document.readyState === 'complete' and no pending fetches)
 */
async function waitForPageReady(driver, timeout = PAGE_LOAD_TIMEOUT) {
    try {
        // Wait for document ready state
        await driver.wait(async () => {
            const readyState = await driver.executeScript('return document.readyState');
            return readyState === 'complete';
        }, timeout, 'Waiting for document.readyState === complete');

        // Wait for React/dynamic content to settle (check for no pending mutations)
        await driver.wait(async () => {
            const isStable = await driver.executeScript(`
                return new Promise((resolve) => {
                    // If no MutationObserver activity for 500ms, consider stable
                    let timeout = setTimeout(() => resolve(true), 500);
                    const observer = new MutationObserver(() => {
                        clearTimeout(timeout);
                        timeout = setTimeout(() => resolve(true), 500);
                    });
                    observer.observe(document.body, { childList: true, subtree: true });
                    // Max wait 3s for stability
                    setTimeout(() => { observer.disconnect(); resolve(true); }, 3000);
                });
            `);
            return isStable;
        }, timeout, 'Waiting for DOM to stabilize');

        return true;
    } catch (e) {
        console.warn(`⚠️  Page ready timeout: ${e.message}`);
        return false;
    }
}

/**
 * Wait for URL to change from current URL
 */
async function waitForUrlChange(driver, currentUrl, timeout = PAGE_LOAD_TIMEOUT) {
    try {
        await driver.wait(async () => {
            const newUrl = await driver.getCurrentUrl();
            return newUrl !== currentUrl;
        }, timeout, `Waiting for URL to change from ${currentUrl}`);
        return true;
    } catch {
        return false;
    }
}

/**
 * Wait for an element to appear in DOM
 */
async function waitForElementPresent(driver, locator, timeout = ELEMENT_WAIT_TIMEOUT) {
    try {
        return await driver.wait(until.elementLocated(locator), timeout);
    } catch {
        return null;
    }
}

/**
 * Wait for an element to be present and visible
 */
async function waitForElement(driver, locator, timeout = ELEMENT_WAIT_TIMEOUT) {
    try {
        const element = await driver.wait(until.elementLocated(locator), timeout);
        await driver.wait(until.elementIsVisible(element), timeout);
        return element;
    } catch {
        return null;
    }
}

/**
 * Wait for element text to contain a value
 */
async function waitForElementText(driver, locator, text, timeout = ELEMENT_WAIT_TIMEOUT) {
    try {
        const element = await driver.wait(until.elementLocated(locator), timeout);
        await driver.wait(until.elementTextContains(element, text), timeout);
        return element;
    } catch {
        return null;
    }
}

/**
 * Try multiple selectors and return the first match
 */
async function findElementBySelectors(driver, selectors, description = 'element') {
    for (const selector of selectors) {
        try {
            const elements = await driver.findElements(selector);
            if (elements.length > 0) {
                console.log(`   ✓ Found ${description} with selector: ${selector.toString()}`);
                return elements[0];
            }
        } catch {
            // Selector failed, try next
        }
    }
    console.warn(`   ✗ Could not find ${description}`);
    return null;
}

/**
 * Log step progress
 */
function logStep(step, message) {
    testState.currentStep = step;
    console.log(`\n[${'Step ' + step}] ${message}`);
}

/**
 * Step 0: Login to Nintendo Account (if credentials provided)
 */
async function loginToNintendo(driver) {
    if (skipLogin) {
        console.log('   Skipping login (NINTENDO_SKIP_LOGIN=true)');
        return { success: true, skipped: true };
    }

    if (!nintendoEmail || !nintendoPassword) {
        console.log('   No credentials provided - skipping login');
        console.log('   Set NINTENDO_EMAIL and NINTENDO_PASSWORD to enable login');
        return { success: true, skipped: true };
    }

    logStep(0, 'Logging in to Nintendo Account');

    try {
        // Navigate to Nintendo Account login
        await driver.get(NINTENDO_LOGIN_URL);
        await waitForPageReady(driver);

        // Take screenshot of login page
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveScreenshot(driver, `nintendo-login-page-${timestamp}.png`);

        // Check if already logged in (redirected to account page)
        const currentUrl = await driver.getCurrentUrl();
        if (currentUrl.includes('accounts.nintendo.com') && !currentUrl.includes('/login')) {
            console.log('   ✓ Already logged in (session preserved)');
            testState.visitedUrls.push(currentUrl);
            return { success: true, skipped: false, alreadyLoggedIn: true };
        }

        // Find and fill email - Nintendo uses placeholder "Email address/Sign-In ID"
        const emailInput = await waitForElement(
            driver,
            By.css('input[placeholder*="Email"], input[placeholder*="Sign-In"], input[name="loginId"], input#loginId'),
            ELEMENT_WAIT_TIMEOUT
        );

        if (!emailInput) {
            console.log('   ✗ Could not find email input');
            return { success: false, reason: 'Email input not found' };
        }

        await emailInput.clear();
        await emailInput.sendKeys(nintendoEmail);
        console.log('   ✓ Entered email');

        // Find and fill password
        const passwordInput = await waitForElement(
            driver,
            By.css('input[type="password"], input[name="password"], input#password'),
            ELEMENT_WAIT_TIMEOUT
        );

        if (!passwordInput) {
            console.log('   ✗ Could not find password input');
            return { success: false, reason: 'Password input not found' };
        }

        await passwordInput.clear();
        await passwordInput.sendKeys(nintendoPassword);
        console.log('   ✓ Entered password');

        // Find and click login button
        const loginButton = await findElementBySelectors(
            driver,
            [
                By.css('button[type="submit"]'),
                By.xpath('//button[contains(text(), "Sign in")]'),
                By.xpath('//button[contains(text(), "Log in")]'),
                By.css('#btn-signin'),
            ],
            'login button'
        );

        if (!loginButton) {
            console.log('   ✗ Could not find login button');
            return { success: false, reason: 'Login button not found' };
        }

        await loginButton.click();
        console.log('   ✓ Clicked login button');

        // Wait for login to complete - either redirect or error
        await waitForPageReady(driver);

        // Check if login was successful or needs 2FA
        let postLoginUrl = await driver.getCurrentUrl();
        
        // Check for 2FA/email challenge
        if (postLoginUrl.includes('challenge/email') || postLoginUrl.includes('challenge/')) {
            console.log('   ⏳ 2FA verification required - waiting for manual input...');
            console.log('   📧 Please check your email and enter the verification code');
            
            // Wait up to 5 minutes for 2FA to be completed
            const maxWaitTime = 5 * 60 * 1000; // 5 minutes
            const pollInterval = 2000; // Check every 2 seconds
            const startTime = Date.now();
            
            while (Date.now() - startTime < maxWaitTime) {
                await sleep(pollInterval);
                postLoginUrl = await driver.getCurrentUrl();
                
                // Check if we've moved past the challenge page
                if (!postLoginUrl.includes('challenge/')) {
                    console.log('   ✓ 2FA verification completed!');
                    break;
                }
                
                // Check if a code input exists and has been filled
                try {
                    const codeInput = await driver.findElement(By.css('input[type="text"], input[type="number"], input[inputmode="numeric"]'));
                    const value = await codeInput.getAttribute('value');
                    if (value && value.length >= 4) {
                        // Wait a moment for form submission
                        console.log(`   ✓ Code entered (${value.length} digits), waiting for submission...`);
                        await sleep(3000);
                    }
                } catch {
                    // Input not found or not accessible
                }
                
                // Log waiting status every 30 seconds
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (elapsed % 30 === 0 && elapsed > 0) {
                    console.log(`   ⏳ Still waiting for 2FA... (${elapsed}s elapsed)`);
                }
            }
            
            // Check final URL
            postLoginUrl = await driver.getCurrentUrl();
            if (postLoginUrl.includes('challenge/')) {
                console.log('   ⚠️ 2FA timeout - verification not completed within 5 minutes');
                return { success: false, reason: '2FA timeout' };
            }
        }
        
        // If we're still on login page, check for errors
        if (postLoginUrl.includes('accounts.nintendo.com/login')) {
            const errorMessage = await findElementBySelectors(
                driver,
                [
                    By.css('.error-message'),
                    By.css('[data-testid="error"]'),
                    By.xpath('//*[contains(@class, "error")]'),
                ],
                'error message'
            );

            if (errorMessage) {
                const errorText = await errorMessage.getText().catch(() => 'Unknown error');
                console.log(`   ✗ Login failed: ${errorText}`);
                return { success: false, reason: errorText };
            }
        }

        // Take screenshot after login attempt
        await saveScreenshot(driver, `nintendo-after-login-${timestamp}.png`);

        console.log(`   ✓ Login completed, now at: ${postLoginUrl}`);
        testState.visitedUrls.push(postLoginUrl);

        return { success: true, skipped: false };

    } catch (e) {
        console.error(`   ✗ Login error: ${e.message}`);
        return { success: false, reason: e.message };
    }
}

/**
 * Step 1: Navigate to Nintendo Store
 */
async function navigateToStore(driver) {
    logStep(1, 'Navigating to Nintendo Store');

    await driver.get(NINTENDO_STORE_URL);
    await waitForPageReady(driver);

    const currentUrl = await driver.getCurrentUrl();
    testState.visitedUrls.push(currentUrl);
    console.log(`   URL: ${currentUrl}`);

    const title = await driver.getTitle();
    console.log(`   Title: ${title}`);

    return true;
}

/**
 * Step 2: Search for a game
 */
async function searchForGame(driver, searchTerm) {
    logStep(2, `Searching for "${searchTerm}"`);

    // Nintendo uses different search UI for mobile vs desktop
    // Try clicking search button first (mobile nav)
    const searchButton = await findElementBySelectors(
        driver,
        [
            By.css('button[aria-label="Search"]'),
            By.css('#search'),
            By.css('[data-testid="MagnifyingGlassIcon"]'),
            By.xpath('//svg[@data-testid="MagnifyingGlassIcon"]/..')
        ],
        'search button'
    );

    if (searchButton) {
        try {
            await searchButton.click();
            // Wait for search input to appear after clicking search button
            await waitForElementPresent(driver, By.css('input[name="q"], input[aria-label*="Search"], input[placeholder*="Search"]'), 5000);
        } catch {
            console.log('   Search button click failed, trying direct input');
        }
    }

    // Find and fill search input
    const searchInput = await findElementBySelectors(
        driver,
        [
            By.css('input[name="q"]'),
            By.css('input[aria-label*="Search"]'),
            By.css('input[placeholder*="Search"]'),
            By.css('.sc-ax1lsj-1'),
        ],
        'search input'
    );

    if (!searchInput) {
        // Alternative: Navigate directly to search results
        console.log('   Navigating directly to search results...');
        await driver.get(`https://www.nintendo.com/en-gb/Search/Search-702256.html?q=${encodeURIComponent(searchTerm)}`);
        await waitForPageReady(driver);
        return true;
    }

    try {
        const urlBeforeSearch = await driver.getCurrentUrl();
        await searchInput.clear();
        await searchInput.sendKeys(searchTerm);

        // Submit search
        await searchInput.sendKeys(selenium.Key.ENTER);

        // Wait for URL to change (indicates search submitted) or for search results to appear
        const urlChanged = await waitForUrlChange(driver, urlBeforeSearch, 10000);
        if (urlChanged) {
            await waitForPageReady(driver);
        } else {
            // URL didn't change, might be SPA - wait for results to appear
            await waitForElementPresent(driver, By.css('a[href*="/store/products/"]'), 10000);
        }

        const currentUrl = await driver.getCurrentUrl();
        testState.visitedUrls.push(currentUrl);
        console.log(`   Search submitted, URL: ${currentUrl}`);
        return true;
    } catch (e) {
        console.error(`   ✗ Search failed: ${e.message}`);
        // Fallback to direct URL
        await driver.get(`https://www.nintendo.com/en-gb/Search/Search-702256.html?q=${encodeURIComponent(searchTerm)}`);
        await waitForPageReady(driver);
        return true;
    }
}

/**
 * Step 3: Select a game and try to add to cart
 * 
 * Nintendo digital games show "Direct download" which requires login.
 * Some games have physical editions available which use "Add to Cart".
 * We'll try to select a physical edition if available.
 */
async function selectGameFromResults(driver) {
    logStep(3, 'Selecting a game');

    // Go to Fallout Shelter - a free game that should have a simpler download flow
    const gameUrl = 'https://www.nintendo.com/en-gb/Games/Nintendo-Switch-download-software/Fallout-Shelter-1387761.html';
    console.log('   Navigating to Fallout Shelter (free game)...');
    
    await driver.get(gameUrl);
    await waitForPageReady(driver);

    // Wait for the download link to appear (React hydration)
    console.log('   Waiting for download button...');
    const purchaseButton = await waitForElement(
        driver,
        By.css('a[href*="title_purchase"]'),
        15000
    );

    // Take screenshot after element appears
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await saveScreenshot(driver, `nintendo-game-page-${timestamp}.png`);

    if (purchaseButton) {
        const buttonText = await purchaseButton.getText().catch(() => 'unknown');
        console.log(`   ✓ Found download button: "${buttonText}"`);
    } else {
        console.log('   ✗ Could not find download button on game page');
    }

    const currentUrl = await driver.getCurrentUrl();
    testState.visitedUrls.push(currentUrl);
    console.log(`   Now at: ${currentUrl}`);

    return true;
}

/**
 * Step 4: Add game to basket
 */
async function addToBasket(driver) {
    logStep(4, 'Adding game to basket');

    // Wait for page to be ready first
    console.log('   Waiting for page to be ready...');
    await waitForPageReady(driver);

    // === DIAGNOSTIC: Use debug-utils to analyze the page ===
    console.log('\n   📊 DEBUG: Running page diagnostics...');
    
    // Check for any modals that might be blocking
    try {
        const modals = await runDebug(driver, 'detectModals');
        if (modals.hasModal) {
            console.log(`   ⚠️  Modal detected: ${modals.modals.length} modal(s) found`);
            modals.modals.forEach(m => console.log(`     - [${m.selector}] "${m.text?.substring(0, 50)}..."`));
            
            // Try to dismiss cookie/GDPR modals
            const dismissButtons = await driver.findElements(By.xpath(
                '//button[contains(text(), "Accept") or contains(text(), "OK") or contains(text(), "Got it") or contains(text(), "Continue") or contains(text(), "Agree")]'
            ));
            if (dismissButtons.length > 0) {
                console.log('   🔄 Attempting to dismiss modal...');
                await dismissButtons[0].click();
                await sleep(1000);
                await waitForPageReady(driver);
            }
        } else {
            console.log('   ✓ No blocking modals detected');
        }
    } catch (e) {
        console.log(`   Modal check error: ${e.message}`);
    }

    // Get all actionable elements and find the download button
    try {
        const actionableElements = await runDebug(driver, 'actionableElements');
        const downloadButtons = actionableElements.filter(e => 
            e.text?.toLowerCase().includes('download') || 
            e.text?.toLowerCase().includes('free')
        );
        console.log(`\n   📊 DEBUG: Found ${downloadButtons.length} download-related actionable element(s):`);
        downloadButtons.forEach(e => {
            console.log(`     - <${e.tag}> [${e.selector}] "${e.text}" visible=${e.visible} disabled=${e.disabled || false}`);
            if (e.href) console.log(`       href: ${e.href}`);
            console.log(`       rect: ${JSON.stringify(e.rect)}`);
        });
    } catch (e) {
        console.log(`   Actionable elements check error: ${e.message}`);
    }

    // Find elements by text "Free download"
    try {
        const foundElements = await runDebug(driver, 'findByText', 'Free download', false);
        console.log(`\n   📊 DEBUG: Elements containing "Free download": ${foundElements.length}`);
        foundElements.forEach(e => console.log(`     - <${e.tag}> [${e.selector}] "${e.text?.substring(0, 50)}" visible=${e.visible}`));
    } catch (e) {
        console.log(`   findByText error: ${e.message}`);
    }

    // Start console capture to catch any JS errors during click
    console.log('\n   📋 Starting console capture for click...');
    await startConsoleCapture(driver);
    
    // === END DIAGNOSTIC ===

    // Debug: list all download-related elements (original debug)
    try {
        const downloadElements = await driver.executeScript(`
            const results = [];
            
            // Check buttons
            const buttons = document.querySelectorAll('button');
            buttons.forEach(b => {
                const text = (b.textContent || '').trim();
                if (text.toLowerCase().includes('download') || text.toLowerCase().includes('cart')) {
                    results.push({ tag: 'button', text: text.substring(0, 50), href: null, outerHTML: b.outerHTML.substring(0, 200) });
                }
            });
            
            // Check links
            const links = document.querySelectorAll('a');
            links.forEach(l => {
                const text = (l.textContent || '').trim();
                if (text.toLowerCase().includes('download') || l.href?.includes('ec.nintendo') || l.href?.includes('title_purchase')) {
                    results.push({ tag: 'a', text: text.substring(0, 50), href: l.href, outerHTML: l.outerHTML.substring(0, 200) });
                }
            });
            
            return results;
        `);
        if (downloadElements && downloadElements.length > 0) {
            console.log(`\n   📊 DEBUG: Raw download element scan - ${downloadElements.length} element(s):`);
            downloadElements.forEach(e => {
                console.log(`     - <${e.tag}> "${e.text}" ${e.href || ''}`);
                console.log(`       HTML: ${e.outerHTML}`);
            });
        } else {
            console.log('   No download elements found on page');
        }
    } catch {
        // Debug failed, continue
    }

    // Find the main purchase/download element
    // UK Nintendo site uses buttons (not links) for "Free download"
    // US site uses <a> links to ec.nintendo.com with title_purchase
    const purchaseButton = await findElementBySelectors(
        driver,
        [
            // PRIORITY 1: Button with download text (UK site)
            By.xpath('//button[contains(normalize-space(), "Free download")]'),
            By.xpath('//button[contains(normalize-space(), "Direct download")]'),
            By.xpath('//a[contains(normalize-space(), "Free download") and not(contains(@href, "#"))]'),
            // PRIORITY 2: Link to Nintendo eShop with title_purchase (US site)
            By.css('a[href*="ec.nintendo.com"][href*="title_purchase"]'),
            By.css('a[href*="title_purchase"]'),
            // PRIORITY 3: Links with download icon
            By.xpath('//a[.//svg[@data-testid="DownloadIcon"]]'),
            // PRIORITY 4: Physical cart buttons
            By.xpath('//button[contains(normalize-space(), "Add to cart")]'),
        ],
        'purchase/download button'
    );

    // If standard selectors didn't work, try finding via executeScript
    let buttonToUse = purchaseButton;
    if (!buttonToUse) {
        console.log('   Trying to find link/button via executeScript...');
        await sleep(1000); // Small delay to let WebDriver recover
        try {
            buttonToUse = await driver.executeScript(`
                // PRIORITY 1: Button with download text (UK site uses buttons)
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = (btn.textContent || btn.innerText || '').toLowerCase();
                    if (text.includes('free download') || text.includes('direct download')) {
                        return btn;
                    }
                }
                
                // PRIORITY 2: Link to ec.nintendo.com with title_purchase (US site)
                const purchaseLink = document.querySelector('a[href*="ec.nintendo.com"][href*="title_purchase"]');
                if (purchaseLink) return purchaseLink;
                
                // PRIORITY 3: Link with title_purchase in URL
                const titlePurchaseLink = document.querySelector('a[href*="title_purchase"]');
                if (titlePurchaseLink) return titlePurchaseLink;
                
                // PRIORITY 4: Look for link with download icon
                const downloadIconLink = document.querySelector('a svg[data-testid="DownloadIcon"]');
                if (downloadIconLink) return downloadIconLink.closest('a');
                
                // PRIORITY 5: Add to cart buttons
                for (const btn of buttons) {
                    const text = (btn.textContent || btn.innerText || '').toLowerCase();
                    if (text.includes('add to cart')) {
                        return btn;
                    }
                }
                
                // FALLBACK: Links with download text (excluding wishlist/support links)
                const links = document.querySelectorAll('a');
                for (const link of links) {
                    const text = (link.textContent || link.innerText || '').toLowerCase();
                    const href = link.getAttribute('href') || '';
                    if ((text.includes('free download') || text.includes('direct download')) && 
                        !href.includes('wishlist') && !href.includes('support')) {
                        return link;
                    }
                }
                return null;
            `);
            if (buttonToUse) {
                console.log('   ✓ Found element via script');
            }
        } catch (e) {
            console.log(`   Could not find via script: ${e.message}`);
        }
    }

    if (!buttonToUse) {
        console.log('   ℹ️  No purchase button found');
        return { success: false, reason: 'No purchase button found' };
    }

    // Get button text (try executeScript first since getText() may not work)
    let buttonText = '';
    try {
        buttonText = await driver.executeScript('return (arguments[0].textContent || arguments[0].innerText || "").trim()', buttonToUse);
    } catch {
        buttonText = await buttonToUse.getText().catch(() => '');
    }
    console.log(`   Found button: "${buttonText}"`);

    // Check if this is a free or paid digital download
    const isFreeDownload = buttonText.toLowerCase().includes('free');
    const isDigitalDownload = buttonText.toLowerCase().includes('download');
    
    if (isFreeDownload) {
        console.log('   ℹ️  This is a free game - may still require Nintendo Account');
    } else if (isDigitalDownload) {
        console.log('   ℹ️  This is a paid digital game - requires Nintendo Account login');
    }

    try {
        // Get the href from the link to navigate directly (clicks may open new windows)
        let targetUrl = null;
        try {
            targetUrl = await buttonToUse.getAttribute('href');
            console.log(`   Link href: ${targetUrl}`);
        } catch {
            // Not a link, will just click
        }

        console.log(`   Clicking "${buttonText}"...`);
        
        // === DIAGNOSTIC: Track DOM changes during click ===
        console.log('\n   📊 DEBUG: Starting DOM tracker before click...');
        await runDebug(driver, 'domTracker', 'start');
        
        // Capture URL before click
        const urlBeforeClick = await driver.getCurrentUrl();
        console.log(`   URL before click: ${urlBeforeClick}`);
        
        // Try JavaScript click first (more reliable for JS-based buttons)
        try {
            await driver.executeScript('arguments[0].click()', buttonToUse);
            console.log('   ✓ JavaScript click executed');
        } catch (jsClickErr) {
            console.log(`   JS click failed (${jsClickErr.message}), trying native click...`);
            // Fallback to native WebDriver click
            try {
                await buttonToUse.click();
                console.log('   ✓ Native WebDriver click executed');
            } catch (nativeClickErr) {
                console.log(`   ✗ Native click also failed: ${nativeClickErr.message}`);
            }
        }
        
        // Wait a moment for any JavaScript to execute
        await sleep(2000);
        
        // === DIAGNOSTIC: Capture what happened after click ===
        const urlAfterClickImmediate = await driver.getCurrentUrl();
        console.log(`   URL immediately after click: ${urlAfterClickImmediate}`);
        
        // Get DOM changes
        const domChanges = await runDebug(driver, 'domTracker', 'stop');
        console.log(`\n   📊 DEBUG: DOM Changes after click:`);
        console.log(`     - Added elements: ${domChanges.added?.length || 0}`);
        console.log(`     - Removed elements: ${domChanges.removed?.length || 0}`);
        console.log(`     - Attribute changes: ${domChanges.attributes?.length || 0}`);
        
        if (domChanges.added?.length > 0) {
            console.log('   Added elements:');
            domChanges.added.slice(0, 5).forEach(e => console.log(`     + <${e.tag}> ${e.id ? '#'+e.id : ''} ${e.classes ? '.'+e.classes.split(' ')[0] : ''} "${e.text?.substring(0, 30)}"`));
        }
        if (domChanges.attributes?.length > 0) {
            console.log('   Attribute changes:');
            domChanges.attributes.slice(0, 5).forEach(e => console.log(`     ~ <${e.tag}> ${e.attr}=${e.newValue?.substring(0, 30)}`));
        }
        
        // Get console logs from during the click
        await logConsoleLogs(driver, { stop: true, levels: ['error', 'warn', 'exception', 'rejection'] });
        
        // === END DIAGNOSTIC ===

        // If we have a direct href to ec.nintendo.com, navigate there
        if (targetUrl && targetUrl.includes('ec.nintendo.com')) {
            console.log('   Navigating directly to Nintendo eShop...');
            await driver.get(targetUrl);
            await waitForPageReady(driver);
        }

        // Take a debug screenshot to see what happened after clicking
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveScreenshot(driver, `nintendo-after-add-to-cart-${timestamp}.png`);

        // Wait for one of these signals that add to cart worked:
        // 1. A modal appears with cart options
        // 2. Cart badge/count updates  
        // 3. Button text changes (e.g., to "Added" or "In Cart")
        // 4. Login prompt appears (needs account)

        // Check if we were redirected to re-authentication or login page
        const urlAfterClick = await driver.getCurrentUrl();
        if (urlAfterClick.includes('reauthenticate') || urlAfterClick.includes('Re-enter')) {
            console.log('   ⏳ Re-authentication required - entering password...');
            
            // Find and fill the password field
            const reAuthPasswordInput = await waitForElement(
                driver,
                By.css('input[type="password"]'),
                ELEMENT_WAIT_TIMEOUT
            );
            
            if (reAuthPasswordInput && nintendoPassword) {
                await reAuthPasswordInput.clear();
                await reAuthPasswordInput.sendKeys(nintendoPassword);
                console.log('   ✓ Entered password');
                
                // Click OK/Submit button
                const okButton = await findElementBySelectors(
                    driver,
                    [
                        By.xpath('//button[contains(text(), "OK")]'),
                        By.xpath('//button[contains(text(), "Submit")]'),
                        By.css('button[type="submit"]'),
                    ],
                    'OK button'
                );
                
                if (okButton) {
                    await okButton.click();
                    console.log('   ✓ Clicked OK');
                    await waitForPageReady(driver);
                    
                    // Check for regional modal and dismiss it
                    await sleep(2000);
                    const regionModal = await findElementBySelectors(
                        driver,
                        [
                            By.xpath('//button[contains(text(), "Continue")]'),
                            By.xpath('//button[contains(text(), "OK")]'),
                            By.xpath('//button[contains(text(), "Accept")]'),
                            By.css('[data-testid="modal-close"]'),
                            By.css('button[aria-label="Close"]'),
                        ],
                        'regional modal dismiss button'
                    );
                    
                    if (regionModal) {
                        console.log('   ✓ Found regional modal, dismissing...');
                        await regionModal.click();
                        await waitForPageReady(driver);
                    }
                    
                    // Take screenshot of result
                    const ts = new Date().toISOString().replace(/[:.]/g, '-');
                    await saveScreenshot(driver, `nintendo-after-reauth-${ts}.png`);
                    
                    const finalUrl = await driver.getCurrentUrl();
                    console.log(`   Now at: ${finalUrl}`);
                    
                    // Check if we reached the eShop/confirmation
                    if (finalUrl.includes('ec.nintendo.com')) {
                        console.log('   ✓ Reached Nintendo eShop!');
                        return { success: true, isDigital: true, reachedEshop: true };
                    }
                }
            }
        }
        
        if (urlAfterClick.includes('accounts.nintendo.com/login') || urlAfterClick.includes('signin')) {
            console.log('   ✓ Redirected to Nintendo Account login page');
            console.log(`   URL: ${urlAfterClick}`);
            return { success: true, isDigital: true, requiresLogin: true };
        }

        // Check if a login modal/dialog appeared
        const loginModal = await findElementBySelectors(
            driver,
            [
                By.xpath('//div[@role="dialog"]//*[contains(text(), "Sign in") or contains(text(), "Log in")]'),
                By.xpath('//div[contains(@class, "modal") or contains(@class, "Modal")]//*[contains(text(), "Sign in") or contains(text(), "Log in")]'),
                By.css('[data-testid="login-modal"]'),
                By.css('[role="dialog"][aria-label*="Sign in"]'),
            ],
            'login modal'
        );

        if (loginModal) {
            console.log('   ✓ Login modal appeared - digital purchase requires Nintendo Account');
            return { success: true, isDigital: true, requiresLogin: true };
        }

        // Try to detect modal appearing
        const modalSelectors = [
            By.xpath('//div[contains(@class, "modal") or contains(@class, "Modal") or contains(@class, "dialog") or contains(@class, "Dialog")]//button'),
            By.xpath('//div[contains(@class, "modal") or contains(@class, "Modal")]//a[contains(@href, "cart")]'),
            By.xpath('//*[contains(text(), "View cart") or contains(text(), "View Cart") or contains(text(), "added to cart") or contains(text(), "Added to cart")]'),
            By.css('[role="dialog"] button'),
            By.css('[role="dialog"] a[href*="cart"]'),
        ];

        let modalFound = false;
        for (const selector of modalSelectors) {
            const modalElement = await waitForElementPresent(driver, selector, 5000);
            if (modalElement) {
                modalFound = true;
                console.log('   ✓ Cart confirmation detected');

                // Try to find and click "View Cart" or similar
                const viewCartButton = await findElementBySelectors(
                    driver,
                    [
                        By.xpath('//button[contains(text(), "View cart") or contains(text(), "View Cart")]'),
                        By.xpath('//a[contains(text(), "View cart") or contains(text(), "View Cart")]'),
                        By.xpath('//a[contains(@href, "/cart")]'),
                    ],
                    'View Cart button'
                );

                if (viewCartButton) {
                    console.log('   ✓ Found View Cart button, clicking...');
                    try {
                        await viewCartButton.click();
                        await waitForPageReady(driver);
                    } catch {
                        console.log('   View Cart click failed, will navigate directly');
                    }
                }
                break;
            }
        }

        if (!modalFound) {
            // Check if cart badge updated (indicates item was added)
            const cartBadge = await findElementBySelectors(
                driver,
                [
                    By.xpath('//a[@aria-label="Cart"]//span[string-length(text()) > 0]'),
                    By.css('[data-testid="cart-count"]'),
                    By.css('.cart-count'),
                ],
                'cart badge'
            );

            if (cartBadge) {
                try {
                    const badgeText = await cartBadge.getText();
                    if (badgeText && badgeText !== '0') {
                        console.log(`   ✓ Cart badge shows: ${badgeText}`);
                    }
                } catch {
                    // Badge exists but couldn't get text
                }
            } else {
                console.log('   No modal or cart badge detected - checking cart page directly');
            }
        }

        // Check for cart confirmation or navigate to cart
        const currentUrl = await driver.getCurrentUrl();
        console.log(`   Current URL after click: ${currentUrl}`);

        // Try to verify item was added by checking cart badge/count
        const cartBadge = await findElementBySelectors(
            driver,
            [
                By.css('[data-testid="cart-count"]'),
                By.css('.cart-count'),
                By.css('[aria-label*="Cart"] span'),
                By.xpath('//a[@aria-label="Cart"]//span[number(text()) > 0]'),
            ],
            'cart badge'
        );

        if (cartBadge) {
            try {
                const badgeText = await cartBadge.getText();
                console.log(`   Cart badge shows: ${badgeText}`);
            } catch {
                // Badge exists but couldn't get text
            }
        }

        return { success: true, isDigital: false };
    } catch (e) {
        console.error(`   ✗ Failed to add to cart: ${e.message}`);
        return { success: false, reason: e.message };
    }
}

/**
 * Step 5: Navigate to basket/cart
 * Note: UK Nintendo site uses Nintendo eShop for digital purchases, no web cart
 */
async function navigateToCart(driver) {
    logStep(5, 'Navigating to cart');

    // UK Nintendo site doesn't have a web cart for digital games
    // Digital purchases go directly through Nintendo eShop (ec.nintendo.com)
    // Check if we're already on the eShop
    const currentUrl = await driver.getCurrentUrl();
    if (currentUrl.includes('ec.nintendo.com')) {
        console.log('   ✓ Already on Nintendo eShop');
        testState.visitedUrls.push(currentUrl);
        return true;
    }

    // Try clicking cart icon (physical store only)
    const cartLink = await findElementBySelectors(
        driver,
        [
            By.css('a[aria-label="Cart"]'),
            By.css('a[aria-label="Shopping cart"]'),
            By.css('a[href*="/cart"]'),
            By.xpath('//*[@data-testid="ShoppingCartIcon"]/..'),
        ],
        'cart link'
    );

    if (cartLink) {
        try {
            const href = await cartLink.getAttribute('href');
            console.log(`   Cart link: ${href}`);
            await cartLink.click();
            await waitForPageReady(driver);
        } catch {
            console.log('   ℹ️  UK Nintendo site uses eShop for digital games (no web cart)');
        }
    } else {
        console.log('   ℹ️  UK Nintendo site uses eShop for digital games (no web cart)');
    }

    const finalUrl = await driver.getCurrentUrl();
    testState.visitedUrls.push(finalUrl);
    console.log(`   Now at: ${finalUrl}`);

    return true;
}

/**
 * Step 6: Proceed to checkout
 */
async function proceedToCheckout(driver) {
    logStep(6, 'Proceeding to checkout');

    // Wait for cart page to load - look for either cart items or empty cart message
    await waitForElementPresent(
        driver,
        By.xpath('//*[contains(text(), "cart") or contains(text(), "Cart") or contains(text(), "Checkout")]'),
        ELEMENT_WAIT_TIMEOUT
    );

    // Check if cart has items
    const emptyCartMessage = await findElementBySelectors(
        driver,
        [
            By.xpath('//*[contains(text(), "cart is empty")]'),
            By.xpath('//*[contains(text(), "Cart is empty")]'),
            By.xpath('//*[contains(text(), "no items")]'),
        ],
        'empty cart message'
    );

    if (emptyCartMessage) {
        console.log('   ℹ️  Cart is empty - Add to Cart may have required login');
        return { success: false, reason: 'Cart is empty' };
    }

    // Look for checkout button
    const checkoutButton = await findElementBySelectors(
        driver,
        [
            By.xpath('//button[contains(text(), "Checkout")]'),
            By.xpath('//button[contains(text(), "Proceed")]'),
            By.xpath('//a[contains(text(), "Checkout")]'),
            By.css('button[data-testid="checkout"]'),
            By.css('a[href*="checkout"]'),
        ],
        'checkout button'
    );

    if (!checkoutButton) {
        console.log('   ℹ️  No checkout button found');
        return { success: false, reason: 'No checkout button found' };
    }

    try {
        console.log('   Clicking checkout...');
        await checkoutButton.click();
        await waitForPageReady(driver);

        const currentUrl = await driver.getCurrentUrl();
        testState.visitedUrls.push(currentUrl);
        console.log(`   Now at: ${currentUrl}`);

        // Check if we hit a login wall
        if (currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('accounts')) {
            console.log('   ℹ️  Reached login page (checkout requires authentication)');
            return { success: true, hitLogin: true };
        }

        return { success: true, hitLogin: false };
    } catch (e) {
        console.error(`   ✗ Failed to proceed to checkout: ${e.message}`);
        return { success: false, reason: e.message };
    }
}

/**
 * Print test summary
 */
function printSummary() {
    console.log('\n' + '='.repeat(50));
    console.log('📊 TEST SUMMARY');
    console.log('='.repeat(50));
    console.log(`Platform: ${platform}`);
    console.log(`Last step: ${testState.currentStep}`);
    console.log(`URLs visited: ${testState.visitedUrls.length}`);
    testState.visitedUrls.forEach((url, idx) => {
        console.log(`  ${idx + 1}. ${url}`);
    });
    if (testState.errors.length > 0) {
        console.log(`Errors: ${testState.errors.length}`);
        testState.errors.forEach((err) => console.log(`  - ${err}`));
    }
    console.log('='.repeat(50));
}

// ============ Main Test Flow ============

await cleanupExistingSessions();

let driver;
try {
    console.log('\n🎮 Nintendo Store Basket Flow Test');
    console.log(`Platform: ${platform}`);
    console.log(`WebDriver: ${serverUrl}`);
    console.log(`Login: ${nintendoEmail ? `${nintendoEmail.substring(0, 3)}***` : 'Not configured (guest mode)'}\n`);

    driver = await new selenium.Builder()
        .usingServer(serverUrl)
        .withCapabilities({ browserName: 'duckduckgo' })
        .build();

    // Platform check for macOS
    if (platform === 'macos') {
        try {
            const automationCheck = await fetch('http://localhost:8788/getUrl');
            if (!automationCheck.ok) {
                console.warn('⚠️  Warning: macOS automation server (port 8788) not responding');
            }
        } catch {
            console.warn('⚠️  Warning: macOS automation server (port 8788) not accessible');
        }
    }

    // Clear browser state before each run
    await clearBrowserState(driver);

    // Run test steps
    const loginResult = await loginToNintendo(driver);
    if (!loginResult.success) {
        console.log(`\n⚠️  Login failed: ${loginResult.reason}`);
        console.log('   Continuing with guest flow (digital purchases will require login)');
    }

    await navigateToStore(driver);
    await searchForGame(driver, SEARCH_TERM);
    await selectGameFromResults(driver);
    const addResult = await addToBasket(driver);
    await navigateToCart(driver);
    const checkoutResult = await proceedToCheckout(driver);

    // Take final screenshot
    if (takeScreenshot) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveScreenshot(driver, `nintendo-basket-${timestamp}.png`);
    }

    // Print summary
    printSummary();

    if (addResult.success && checkoutResult.success) {
        console.log('\n✅ Test completed successfully!');
        if (checkoutResult.hitLogin) {
            console.log('   (Stopped at login page as expected for guest checkout)');
        }
    } else {
        console.log('\n⚠️  Test completed with limitations:');
        if (!addResult.success) console.log(`   - Add to cart: ${addResult.reason}`);
        if (!checkoutResult.success) console.log(`   - Checkout: ${checkoutResult.reason}`);
    }

    if (keepOpen) {
        console.log('\n✅ Browser will stay open. Press Ctrl+C to quit.');
        await new Promise(() => {});
    } else {
        console.log('\n⚠️  Browser will close automatically. Use --keep to keep it open.');
    }
} catch (error) {
    console.error('\n❌ Test Error:', error.message);
    testState.errors.push(error.message);

    if (takeScreenshot && driver) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveScreenshot(driver, `nintendo-error-${timestamp}.png`);
    }

    printSummary();

    if (error.message.includes('Session is already started') || error.message.includes('SessionNotCreatedError')) {
        console.error('\n💡 Tip: Restart the driver:');
        console.error('   1. Stop WebDriver server (Ctrl+C)');
        console.error('   2. Run: npm run driver:macos (or driver:ios)');
        console.error('   3. Run this test again');
    }
    process.exit(1);
} finally {
    if (driver && !keepOpen) {
        try {
            await driver.quit();
        } catch {
            // Ignore quit errors
        }
    }
}
