/**
 * Nintendo US Store Checkout Flow Test
 *
 * Tests the e-commerce checkout flow on nintendo.com/us:
 * 1. Navigate to US Nintendo store
 * 2. Create/login to Nintendo Account (US region)
 * 3. Go to Nintendo Sound Clock: Alarmo product page
 * 4. Add to cart
 * 5. Go to basket
 * 6. Proceed to secure checkout
 * 7. Fill out address info
 * 8. Verify "Continue to payment" button state
 *
 * BUG BEING TESTED:
 * - In DuckDuckGo browser: "Continue to payment" button is greyed out after filling address
 * - In Safari: "Continue to payment" button works correctly
 *
 * Usage:
 *   node scripts/nintendo-us-checkout-flow.mjs [--no-keep] [--screenshot]
 *
 * Environment:
 *   PLATFORM / TARGET_PLATFORM: 'macos' or 'ios'
 *   WEBDRIVER_SERVER_URL: WebDriver server URL (default: http://localhost:4444)
 *   NINTENDO_EMAIL: Nintendo Account email
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

// Parse --config=<url> argument for custom privacy config (uses cache write)
const configArg = args.find(a => a.startsWith('--config='));
const privacyConfigURL = configArg ? configArg.split('=').slice(1).join('=') : null;

// Parse --config-path=<path> argument for custom privacy config (uses TEST_PRIVACY_CONFIG_PATH env var)
const configPathArg = args.find(a => a.startsWith('--config-path='));
const privacyConfigPath = configPathArg ? configPathArg.split('=').slice(1).join('=') : null;

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';
const platform = process.env.PLATFORM || process.env.TARGET_PLATFORM || 'unknown';

// Nintendo credentials
const nintendoEmail = process.env.NINTENDO_EMAIL;
const nintendoPassword = process.env.NINTENDO_PASSWORD;
const skipLogin = process.env.NINTENDO_SKIP_LOGIN === 'true';

// Config - US Store
const NINTENDO_US_STORE_URL = 'https://www.nintendo.com/us/';
const NINTENDO_LOGIN_URL = 'https://accounts.nintendo.com/login';
const ALARMO_PRODUCT_URL = 'https://www.nintendo.com/us/store/products/nintendo-sound-clock-alarmo-121311/';
const PAGE_LOAD_TIMEOUT = 15000;
const ELEMENT_WAIT_TIMEOUT = 10000;

// Test address info for checkout (US address)
const TEST_ADDRESS = {
    firstName: 'Test',
    lastName: 'User',
    address1: '123 Test Street',
    address2: 'Apt 1',
    city: 'Seattle',
    state: 'WA',
    zip: '98101',
    phone: '2065551234',
};

// Test state tracking
const testState = {
    currentStep: '',
    visitedUrls: [],
    errors: [],
    continueToPaymentEnabled: null,
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
 */
async function clearBrowserState(driver) {
    console.log('🧹 Clearing browser state...');
    try {
        await driver.get(NINTENDO_US_STORE_URL);
        await waitForPageReady(driver);

        await driver.manage().deleteAllCookies();
        console.log('   ✓ Cleared cookies');

        await driver.executeScript(`
            try {
                localStorage.clear();
                sessionStorage.clear();
            } catch (e) {}
        `);
        console.log('   ✓ Cleared localStorage and sessionStorage');

        // Clear Nintendo-specific domains
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
 * Sleep for specified milliseconds
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for page to be ready
 */
async function waitForPageReady(driver, timeout = PAGE_LOAD_TIMEOUT) {
    try {
        await driver.wait(async () => {
            const readyState = await driver.executeScript('return document.readyState');
            return readyState === 'complete';
        }, timeout, 'Waiting for document.readyState === complete');

        await driver.wait(async () => {
            const isStable = await driver.executeScript(`
                return new Promise((resolve) => {
                    let timeout = setTimeout(() => resolve(true), 500);
                    const observer = new MutationObserver(() => {
                        clearTimeout(timeout);
                        timeout = setTimeout(() => resolve(true), 500);
                    });
                    observer.observe(document.body, { childList: true, subtree: true });
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
 * Step 0: Login to Nintendo Account
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
        await driver.get(NINTENDO_LOGIN_URL);
        await waitForPageReady(driver);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveScreenshot(driver, `nintendo-us-login-page-${timestamp}.png`);

        const currentUrl = await driver.getCurrentUrl();
        if (currentUrl.includes('accounts.nintendo.com') && !currentUrl.includes('/login')) {
            console.log('   ✓ Already logged in (session preserved)');
            testState.visitedUrls.push(currentUrl);
            return { success: true, skipped: false, alreadyLoggedIn: true };
        }

        // Find and fill email
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

        await waitForPageReady(driver);

        let postLoginUrl = await driver.getCurrentUrl();

        // Check for 2FA/email challenge
        if (postLoginUrl.includes('challenge/email') || postLoginUrl.includes('challenge/')) {
            console.log('   ⏳ 2FA verification required - waiting for manual input...');
            console.log('   📧 Please check your email and enter the verification code');

            const maxWaitTime = 5 * 60 * 1000;
            const pollInterval = 2000;
            const startTime = Date.now();

            while (Date.now() - startTime < maxWaitTime) {
                await sleep(pollInterval);
                postLoginUrl = await driver.getCurrentUrl();

                if (!postLoginUrl.includes('challenge/')) {
                    console.log('   ✓ 2FA verification completed!');
                    break;
                }

                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (elapsed % 30 === 0 && elapsed > 0) {
                    console.log(`   ⏳ Still waiting for 2FA... (${elapsed}s elapsed)`);
                }
            }

            postLoginUrl = await driver.getCurrentUrl();
            if (postLoginUrl.includes('challenge/')) {
                console.log('   ⚠️ 2FA timeout - verification not completed within 5 minutes');
                return { success: false, reason: '2FA timeout' };
            }
        }

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

        await saveScreenshot(driver, `nintendo-us-after-login-${timestamp}.png`);

        console.log(`   ✓ Login completed, now at: ${postLoginUrl}`);
        testState.visitedUrls.push(postLoginUrl);

        return { success: true, skipped: false };

    } catch (e) {
        console.error(`   ✗ Login error: ${e.message}`);
        return { success: false, reason: e.message };
    }
}

/**
 * Step 1: Navigate to US Nintendo Store
 */
async function navigateToUSStore(driver) {
    logStep(1, 'Navigating to US Nintendo Store');

    await driver.get(NINTENDO_US_STORE_URL);
    await waitForPageReady(driver);

    const currentUrl = await driver.getCurrentUrl();
    testState.visitedUrls.push(currentUrl);
    console.log(`   URL: ${currentUrl}`);

    const title = await driver.getTitle();
    console.log(`   Title: ${title}`);

    return true;
}

/**
 * Step 2: Navigate to Alarmo product page
 */
async function navigateToProduct(driver) {
    logStep(2, 'Navigating to Nintendo Sound Clock: Alarmo product page');

    await driver.get(ALARMO_PRODUCT_URL);
    await waitForPageReady(driver);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await saveScreenshot(driver, `nintendo-us-alarmo-product-${timestamp}.png`);

    const currentUrl = await driver.getCurrentUrl();
    testState.visitedUrls.push(currentUrl);
    console.log(`   URL: ${currentUrl}`);

    // Wait for product page to load - look for Add to Cart button
    const addToCartButton = await waitForElement(
        driver,
        By.xpath('//button[contains(text(), "Add to cart") or contains(text(), "Add to Cart")]'),
        15000
    );

    if (addToCartButton) {
        console.log('   ✓ Product page loaded - Add to Cart button found');
    } else {
        console.log('   ⚠️ Could not find Add to Cart button on product page');
    }

    return true;
}

/**
 * Step 3: Add product to cart
 */
async function addToCart(driver) {
    logStep(3, 'Adding product to cart');

    await waitForPageReady(driver);

    // Find Add to Cart button
    const addToCartButton = await findElementBySelectors(
        driver,
        [
            By.xpath('//button[contains(normalize-space(), "Add to cart")]'),
            By.xpath('//button[contains(normalize-space(), "Add to Cart")]'),
            By.css('button[data-testid="add-to-cart"]'),
            By.css('button.add-to-cart'),
        ],
        'Add to Cart button'
    );

    if (!addToCartButton) {
        console.log('   ✗ Could not find Add to Cart button');
        return { success: false, reason: 'Add to Cart button not found' };
    }

    try {
        const buttonText = await addToCartButton.getText().catch(() => 'Add to Cart');
        console.log(`   Found button: "${buttonText}"`);

        // Start console capture
        await startConsoleCapture(driver);

        // Click Add to Cart
        console.log('   Clicking Add to Cart...');
        await driver.executeScript('arguments[0].click()', addToCartButton);

        await sleep(2000);
        await waitForPageReady(driver);

        // Check for cart confirmation modal or redirect
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveScreenshot(driver, `nintendo-us-after-add-to-cart-${timestamp}.png`);

        // Look for confirmation (cart modal, updated cart count, etc.)
        const cartConfirmation = await findElementBySelectors(
            driver,
            [
                By.xpath('//*[contains(text(), "Added to cart") or contains(text(), "added to cart")]'),
                By.xpath('//*[contains(text(), "View cart") or contains(text(), "View Cart")]'),
                By.css('[role="dialog"]'),
                By.css('.cart-modal'),
            ],
            'cart confirmation'
        );

        if (cartConfirmation) {
            console.log('   ✓ Item added to cart (confirmation detected)');
        } else {
            console.log('   ℹ️  No explicit confirmation - checking cart count');
        }

        // Get console logs
        await logConsoleLogs(driver, { stop: true, levels: ['error', 'warn'] });

        return { success: true };

    } catch (e) {
        console.error(`   ✗ Failed to add to cart: ${e.message}`);
        return { success: false, reason: e.message };
    }
}

/**
 * Dismiss any regional/cookie modals that appear
 * Specifically handles the Nintendo "Select your region" modal
 */
async function dismissModals(driver, maxAttempts = 3) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        console.log(`   Checking for modals to dismiss (attempt ${attempt + 1})...`);
        
        // First, try to click "Stay here" button on the regional modal
        // This is the correct way to proceed with US store
        try {
            const dismissed = await driver.executeScript(`
                // Check if the regional modal is visible by looking for "Stay here" button
                // Note: The search overlay also has role="dialog" but has inert="inert" 
                // so we specifically look for the "Stay here" button presence
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = (btn.textContent || btn.innerText || '').trim();
                    if (text === 'Stay here' || text.includes('Stay here')) {
                        // Regional modal is visible - click the button
                        console.log('Found Stay here button, clicking...');
                        btn.click();
                        return 'stay-here';
                    }
                }
                
                // No "Stay here" button found - regional modal is not visible
                return null;
            `);
            
            if (dismissed === 'stay-here') {
                console.log(`   ✓ Clicked "Stay here" button`);
                await sleep(2000);
                await waitForPageReady(driver);
                
                // Check if "Stay here" button is still present (meaning modal didn't close)
                // Don't use [role="dialog"] - the search overlay always has that
                const modalStillThere = await driver.executeScript(`
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        const text = (btn.textContent || btn.innerText || '').trim();
                        if (text === 'Stay here' || text.includes('Stay here')) {
                            return true;
                        }
                    }
                    return false;
                `);
                if (!modalStillThere) {
                    console.log(`   ✓ Modal dismissed successfully`);
                    return true;
                }
                console.log(`   Modal still visible, retrying...`);
            } else {
                console.log('   No regional modal found (no "Stay here" button)');
                return false;
            }
        } catch (e) {
            console.log(`   Modal dismiss error: ${e.message}`);
        }
        
        await sleep(1000);
    }
    
    return false;
}

/**
 * Step 4: Navigate to cart/basket
 */
async function navigateToCart(driver) {
    logStep(4, 'Navigating to cart');

    // Try clicking cart icon or View Cart button
    const cartLink = await findElementBySelectors(
        driver,
        [
            By.xpath('//button[contains(text(), "View cart") or contains(text(), "View Cart")]'),
            By.xpath('//a[contains(text(), "View cart") or contains(text(), "View Cart")]'),
            By.css('a[aria-label="Cart"]'),
            By.css('a[aria-label="Shopping cart"]'),
            By.css('a[href*="/cart"]'),
            By.xpath('//*[@data-testid="ShoppingCartIcon"]/..'),
            By.css('[data-testid="cart-icon"]'),
        ],
        'cart link'
    );

    if (cartLink) {
        try {
            await cartLink.click();
            await waitForPageReady(driver);
        } catch (e) {
            console.log(`   Click failed: ${e.message}, navigating directly to cart`);
            await driver.get('https://www.nintendo.com/us/cart/');
            await waitForPageReady(driver);
        }
    } else {
        console.log('   Navigating directly to cart page...');
        await driver.get('https://www.nintendo.com/us/cart/');
        await waitForPageReady(driver);
    }

    // Dismiss any regional modals that appear
    await sleep(2000); // Wait for modal to appear
    await dismissModals(driver);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await saveScreenshot(driver, `nintendo-us-cart-${timestamp}.png`);

    const currentUrl = await driver.getCurrentUrl();
    testState.visitedUrls.push(currentUrl);
    console.log(`   Now at: ${currentUrl}`);

    return true;
}

/**
 * Step 5: Proceed to secure checkout
 */
async function proceedToCheckout(driver) {
    logStep(5, 'Proceeding to secure checkout');

    await waitForPageReady(driver);

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
        console.log('   ⚠️ Cart is empty');
        return { success: false, reason: 'Cart is empty' };
    }

    // Dismiss any modals that might be blocking
    await dismissModals(driver);

    // Look for checkout button
    const checkoutButton = await findElementBySelectors(
        driver,
        [
            By.xpath('//button[contains(normalize-space(), "secure checkout")]'),
            By.xpath('//button[contains(normalize-space(), "Secure checkout")]'),
            By.xpath('//button[contains(normalize-space(), "To secure checkout")]'),
            By.xpath('//button[contains(normalize-space(), "Checkout")]'),
            By.xpath('//a[contains(normalize-space(), "secure checkout")]'),
            By.xpath('//a[contains(normalize-space(), "Secure checkout")]'),
            By.xpath('//a[contains(normalize-space(), "Checkout")]'),
            By.css('button[data-testid="checkout"]'),
            By.css('a[href*="checkout"]'),
        ],
        'checkout button'
    );

    if (!checkoutButton) {
        console.log('   ✗ Could not find checkout button');
        return { success: false, reason: 'Checkout button not found' };
    }

    try {
        const buttonText = await checkoutButton.getText().catch(() => 'Checkout');
        console.log(`   Found button: "${buttonText}"`);

        console.log('   Clicking checkout...');
        await driver.executeScript('arguments[0].click()', checkoutButton);

        await sleep(3000);
        await waitForPageReady(driver);
        
        // Dismiss any modal that appears after clicking checkout
        await dismissModals(driver, 5);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveScreenshot(driver, `nintendo-us-checkout-page-${timestamp}.png`);

        const currentUrl = await driver.getCurrentUrl();
        testState.visitedUrls.push(currentUrl);
        console.log(`   Now at: ${currentUrl}`);

        // Check if we hit a login wall
        if (currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('accounts')) {
            console.log('   ⚠️ Reached login page (checkout requires authentication)');
            return { success: true, hitLogin: true };
        }

        return { success: true, hitLogin: false };

    } catch (e) {
        console.error(`   ✗ Failed to proceed to checkout: ${e.message}`);
        return { success: false, reason: e.message };
    }
}

/**
 * Step 6: Fill out address information
 */
async function fillAddressInfo(driver) {
    logStep(6, 'Filling out address information');

    await waitForPageReady(driver);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    try {
        // Wait for address form to appear
        const addressForm = await waitForElementPresent(
            driver,
            By.xpath('//form | //input[@name="firstName"] | //input[@id="firstName"] | //input[contains(@placeholder, "First")]'),
            15000
        );

        if (!addressForm) {
            console.log('   ⚠️ Address form not found - may need to select shipping option first');
            await saveScreenshot(driver, `nintendo-us-no-address-form-${timestamp}.png`);
        }

        // Helper to fill input field
        async function fillInput(selectors, value, fieldName) {
            const input = await findElementBySelectors(driver, selectors, fieldName);
            if (input) {
                try {
                    await input.clear();
                    await input.sendKeys(value);
                    console.log(`   ✓ Filled ${fieldName}: ${value}`);
                    return true;
                } catch (e) {
                    console.log(`   ⚠️ Could not fill ${fieldName}: ${e.message}`);
                }
            }
            return false;
        }

        // Fill first name
        await fillInput(
            [
                By.css('input[name="firstName"]'),
                By.css('input#firstName'),
                By.css('input[placeholder*="First"]'),
                By.xpath('//label[contains(text(), "First")]/following-sibling::input | //label[contains(text(), "First")]/..//input'),
            ],
            TEST_ADDRESS.firstName,
            'First Name'
        );

        // Fill last name
        await fillInput(
            [
                By.css('input[name="lastName"]'),
                By.css('input#lastName'),
                By.css('input[placeholder*="Last"]'),
                By.xpath('//label[contains(text(), "Last")]/following-sibling::input | //label[contains(text(), "Last")]/..//input'),
            ],
            TEST_ADDRESS.lastName,
            'Last Name'
        );

        // Fill address line 1
        await fillInput(
            [
                By.css('input[name="address1"]'),
                By.css('input[name="addressLine1"]'),
                By.css('input#address1'),
                By.css('input[placeholder*="Address"]'),
                By.xpath('//label[contains(text(), "Address")]/following-sibling::input | //label[contains(text(), "Street")]/..//input'),
            ],
            TEST_ADDRESS.address1,
            'Address Line 1'
        );

        // Fill address line 2 (optional)
        await fillInput(
            [
                By.css('input[name="address2"]'),
                By.css('input[name="addressLine2"]'),
                By.css('input#address2'),
                By.css('input[placeholder*="Apt"]'),
            ],
            TEST_ADDRESS.address2,
            'Address Line 2'
        );

        // Fill city
        await fillInput(
            [
                By.css('input[name="city"]'),
                By.css('input#city'),
                By.css('input[placeholder*="City"]'),
                By.xpath('//label[contains(text(), "City")]/following-sibling::input | //label[contains(text(), "City")]/..//input'),
            ],
            TEST_ADDRESS.city,
            'City'
        );

        // Fill state (might be a dropdown)
        const stateInput = await findElementBySelectors(
            driver,
            [
                By.css('select[name="state"]'),
                By.css('select#state'),
                By.css('select[name="region"]'),
                By.css('input[name="state"]'),
                By.css('input#state'),
            ],
            'State'
        );

        if (stateInput) {
            const tagName = await stateInput.getTagName();
            if (tagName.toLowerCase() === 'select') {
                // It's a dropdown - select by value or visible text
                try {
                    await driver.executeScript(`
                        const select = arguments[0];
                        for (const option of select.options) {
                            if (option.value === '${TEST_ADDRESS.state}' || option.text.includes('${TEST_ADDRESS.state}') || option.text.includes('Washington')) {
                                option.selected = true;
                                select.dispatchEvent(new Event('change', { bubbles: true }));
                                break;
                            }
                        }
                    `, stateInput);
                    console.log(`   ✓ Selected State: ${TEST_ADDRESS.state}`);
                } catch (e) {
                    console.log(`   ⚠️ Could not select state: ${e.message}`);
                }
            } else {
                await stateInput.clear();
                await stateInput.sendKeys(TEST_ADDRESS.state);
                console.log(`   ✓ Filled State: ${TEST_ADDRESS.state}`);
            }
        }

        // Fill ZIP code
        await fillInput(
            [
                By.css('input[name="zip"]'),
                By.css('input[name="postalCode"]'),
                By.css('input#zip'),
                By.css('input#postalCode'),
                By.css('input[placeholder*="ZIP"]'),
                By.css('input[placeholder*="Postal"]'),
            ],
            TEST_ADDRESS.zip,
            'ZIP Code'
        );

        // Fill phone number
        await fillInput(
            [
                By.css('input[name="phone"]'),
                By.css('input[name="phoneNumber"]'),
                By.css('input#phone'),
                By.css('input[type="tel"]'),
                By.css('input[placeholder*="Phone"]'),
            ],
            TEST_ADDRESS.phone,
            'Phone Number'
        );

        await sleep(1000);
        await saveScreenshot(driver, `nintendo-us-address-filled-${timestamp}.png`);

        console.log('   ✓ Address form filled');
        return { success: true };

    } catch (e) {
        console.error(`   ✗ Failed to fill address: ${e.message}`);
        await saveScreenshot(driver, `nintendo-us-address-error-${timestamp}.png`);
        return { success: false, reason: e.message };
    }
}

/**
 * Step 7: Check "Continue to payment" button state
 * This is the key test - the button should be enabled after filling address info
 */
async function checkContinueToPaymentButton(driver) {
    logStep(7, 'Checking "Continue to payment" button state');

    await waitForPageReady(driver);
    await sleep(2000); // Wait for any validation to complete

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    try {
        // Find the Continue to payment button
        const continueButton = await findElementBySelectors(
            driver,
            [
                By.xpath('//button[contains(normalize-space(), "Continue to payment")]'),
                By.xpath('//button[contains(normalize-space(), "Continue to Payment")]'),
                By.xpath('//button[contains(normalize-space(), "continue to payment")]'),
                By.css('button[data-testid="continue-to-payment"]'),
                By.css('button.continue-to-payment'),
                By.xpath('//button[contains(@class, "payment")]'),
            ],
            'Continue to payment button'
        );

        if (!continueButton) {
            console.log('   ✗ Could not find "Continue to payment" button');
            await saveScreenshot(driver, `nintendo-us-no-continue-button-${timestamp}.png`);
            return { success: false, reason: 'Continue to payment button not found' };
        }

        // Check if button is enabled or disabled
        const isDisabled = await driver.executeScript(`
            const btn = arguments[0];
            const disabled = btn.disabled;
            const ariaDisabled = btn.getAttribute('aria-disabled') === 'true';
            const hasDisabledClass = btn.classList.contains('disabled') || btn.classList.contains('is-disabled');
            const computedStyle = window.getComputedStyle(btn);
            const pointerEventsNone = computedStyle.pointerEvents === 'none';
            const opacity = parseFloat(computedStyle.opacity);
            const looksDisabled = opacity < 0.6;
            
            return {
                disabled,
                ariaDisabled,
                hasDisabledClass,
                pointerEventsNone,
                opacity,
                looksDisabled,
                isEffectivelyDisabled: disabled || ariaDisabled || hasDisabledClass || pointerEventsNone
            };
        `, continueButton);

        const buttonText = await continueButton.getText().catch(() => 'Continue to payment');

        console.log(`   Button text: "${buttonText}"`);
        console.log(`   Button state analysis:`);
        console.log(`     - disabled attribute: ${isDisabled.disabled}`);
        console.log(`     - aria-disabled: ${isDisabled.ariaDisabled}`);
        console.log(`     - has disabled class: ${isDisabled.hasDisabledClass}`);
        console.log(`     - pointer-events: none: ${isDisabled.pointerEventsNone}`);
        console.log(`     - opacity: ${isDisabled.opacity}`);
        console.log(`     - looks disabled (opacity < 0.6): ${isDisabled.looksDisabled}`);

        const isButtonEnabled = !isDisabled.isEffectivelyDisabled && !isDisabled.looksDisabled;
        testState.continueToPaymentEnabled = isButtonEnabled;

        await saveScreenshot(driver, `nintendo-us-continue-button-${isButtonEnabled ? 'enabled' : 'disabled'}-${timestamp}.png`);

        if (isButtonEnabled) {
            console.log('   ✅ "Continue to payment" button is ENABLED (expected in Safari)');
        } else {
            console.log('   ❌ "Continue to payment" button is GREYED OUT/DISABLED');
            console.log('   🐛 BUG CONFIRMED: Button should be enabled after filling address info');
        }

        // Also try to click the button to see what happens
        if (!isButtonEnabled) {
            console.log('\n   📊 Additional diagnostics:');
            
            // Check for validation errors
            const validationErrors = await driver.executeScript(`
                const errors = [];
                document.querySelectorAll('.error, .invalid, [aria-invalid="true"], .validation-error, .field-error').forEach(el => {
                    const text = el.textContent?.trim();
                    if (text) errors.push(text);
                });
                return errors;
            `);

            if (validationErrors && validationErrors.length > 0) {
                console.log('   Validation errors found:');
                validationErrors.forEach(err => console.log(`     - ${err}`));
            } else {
                console.log('   No visible validation errors found');
            }

            // Check for required fields that might be empty
            const emptyRequiredFields = await driver.executeScript(`
                const empty = [];
                document.querySelectorAll('input[required], input[aria-required="true"]').forEach(input => {
                    if (!input.value) {
                        const label = document.querySelector('label[for="' + input.id + '"]')?.textContent ||
                                      input.placeholder || input.name || input.id;
                        empty.push(label);
                    }
                });
                return empty;
            `);

            if (emptyRequiredFields && emptyRequiredFields.length > 0) {
                console.log('   Empty required fields:');
                emptyRequiredFields.forEach(field => console.log(`     - ${field}`));
            } else {
                console.log('   All required fields appear to be filled');
            }
        }

        return { 
            success: true, 
            buttonEnabled: isButtonEnabled,
            buttonState: isDisabled
        };

    } catch (e) {
        console.error(`   ✗ Failed to check button state: ${e.message}`);
        await saveScreenshot(driver, `nintendo-us-button-check-error-${timestamp}.png`);
        return { success: false, reason: e.message };
    }
}

/**
 * Print test summary
 */
function printSummary() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 TEST SUMMARY - Nintendo US Checkout Flow');
    console.log('='.repeat(60));
    console.log(`Platform: ${platform}`);
    console.log(`Last step: ${testState.currentStep}`);
    console.log(`URLs visited: ${testState.visitedUrls.length}`);
    testState.visitedUrls.forEach((url, idx) => {
        console.log(`  ${idx + 1}. ${url}`);
    });
    
    console.log('\n' + '-'.repeat(60));
    console.log('🎯 KEY RESULT: "Continue to payment" button state');
    console.log('-'.repeat(60));
    
    if (testState.continueToPaymentEnabled === null) {
        console.log('   ⚠️  Could not determine button state');
    } else if (testState.continueToPaymentEnabled) {
        console.log('   ✅ Button is ENABLED - working correctly');
    } else {
        console.log('   ❌ Button is DISABLED/GREYED OUT - BUG CONFIRMED');
        console.log('   📝 Expected: Button should be enabled after filling address');
        console.log('   📝 Note: This works correctly in Safari');
    }
    
    if (testState.errors.length > 0) {
        console.log('\nErrors:');
        testState.errors.forEach((err) => console.log(`  - ${err}`));
    }
    console.log('='.repeat(60));
}

// ============ Main Test Flow ============

await cleanupExistingSessions();

let driver;
try {
    console.log('\n🛒 Nintendo US Store Checkout Flow Test');
    console.log('========================================');
    console.log(`Platform: ${platform}`);
    console.log(`WebDriver: ${serverUrl}`);
    console.log(`Login: ${nintendoEmail ? `${nintendoEmail.substring(0, 3)}***` : 'Not configured (guest mode)'}`);
    console.log(`Product: Nintendo Sound Clock: Alarmo`);
    console.log(`Test: Verify "Continue to payment" button is enabled after filling address`);
    if (privacyConfigURL) {
        console.log(`Custom Config (URL): ${privacyConfigURL}`);
    }
    if (privacyConfigPath) {
        console.log(`Custom Config (Path): ${privacyConfigPath}`);
    }
    console.log('');

    // Build capabilities - optionally include custom privacy config
    const capabilities = { browserName: 'duckduckgo' };
    if (privacyConfigURL) {
        // URL-based: WebDriver fetches and writes to cache
        capabilities['ddg:privacyConfigURL'] = privacyConfigURL;
    }
    if (privacyConfigPath) {
        // Path-based: WebDriver passes TEST_PRIVACY_CONFIG_PATH env var to app
        capabilities['ddg:privacyConfigPath'] = privacyConfigPath;
    }

    driver = await new selenium.Builder()
        .usingServer(serverUrl)
        .withCapabilities(capabilities)
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
        console.log('   Continuing - checkout may require login');
    }

    await navigateToUSStore(driver);
    await navigateToProduct(driver);
    const addResult = await addToCart(driver);
    
    if (!addResult.success) {
        console.log(`\n⚠️  Add to cart failed: ${addResult.reason}`);
    }

    await navigateToCart(driver);
    const checkoutResult = await proceedToCheckout(driver);

    if (checkoutResult.hitLogin) {
        console.log('\n⚠️  Test stopped at login page - need valid Nintendo account credentials');
    } else if (checkoutResult.success) {
        await fillAddressInfo(driver);
        await checkContinueToPaymentButton(driver);
    }

    // Take final screenshot
    if (takeScreenshot) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveScreenshot(driver, `nintendo-us-checkout-final-${timestamp}.png`);
    }

    // Print summary
    printSummary();

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
        await saveScreenshot(driver, `nintendo-us-error-${timestamp}.png`);
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
