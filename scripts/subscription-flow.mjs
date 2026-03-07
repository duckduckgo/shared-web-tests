/**
 * Subscription Payment Flow Automation
 *
 * End-to-end test of the DuckDuckGo macOS subscription purchase flow
 * using a dev box (SERP dev instance) and a fake Stripe checkout
 * hosted on payment-company.site.
 *
 * Pre-requisites:
 *   1. WebDriver running:  npm run driver:macos
 *   2. Dev box accessible:  DEV_BOX_URL env var
 *   3. macOS app configured with:
 *      - customBaseSubscriptionURL → dev box subscriptions URL
 *      - purchasePlatform → stripe
 *      - isInternalUser → true
 *
 * Usage:
 *   node scripts/subscription-flow.mjs [options]
 *
 * Options:
 *   --keep          Keep browser open after test (default)
 *   --no-keep       Close browser when done
 *   --screenshot    Save screenshots at each step
 *   --auto-pay      Use autoPay on the fake checkout (no manual click)
 *
 * Environment variables:
 *   DEV_BOX_URL            Dev box base URL (required)
 *   DEV_BOX_USERNAME       OAuth username (if dev box requires auth)
 *   DEV_BOX_PASSWORD       OAuth password (if dev box requires auth)
 *   WEBDRIVER_SERVER_URL   WebDriver URL (default: http://localhost:4444)
 *   PAYMENT_PAGE_URL       Fake checkout base URL (default: https://www.payment-company.site)
 */

import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);

/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');
const { By } = selenium;

// --- Configuration -----------------------------------------------------------

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep') || !args.includes('--no-keep');
const takeScreenshots = args.includes('--screenshot');
const useAutoPay = args.includes('--auto-pay');

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';
const devBoxUrl = process.env.DEV_BOX_URL;
const devBoxUsername = process.env.DEV_BOX_USERNAME;
const devBoxPassword = process.env.DEV_BOX_PASSWORD;
const paymentPageBase = process.env.PAYMENT_PAGE_URL ?? 'https://www.payment-company.site';

if (!devBoxUrl) {
    console.error('❌ DEV_BOX_URL environment variable is required.');
    console.error('   Example: DEV_BOX_URL=https://euw-serp-dev-testing16.duckduckgo.com');
    process.exit(1);
}

const subscriptionsUrl = `${devBoxUrl}/subscriptions?origin=funnel_appmenu_macos`;

// --- Helpers -----------------------------------------------------------------

let screenshotCount = 0;

async function screenshot(driver, label) {
    if (!takeScreenshots) return;
    screenshotCount++;
    const screenshotsDir = join(scriptsDir, '..', 'screenshots');
    try {
        await mkdir(screenshotsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `subscription-${screenshotCount}-${label}-${timestamp}.png`;
        const base64 = await driver.takeScreenshot();
        await writeFile(join(screenshotsDir, filename), Buffer.from(base64, 'base64'));
        console.log(`   📸 ${filename}`);
    } catch (e) {
        console.warn(`   ⚠ Screenshot failed: ${e.message}`);
    }
}

async function waitForPageReady(driver, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const readyState = await driver.executeScript('return document.readyState');
            if (readyState === 'complete') {
                await sleep(500); // let dynamic JS settle
                return true;
            }
        } catch {
            // retry
        }
        await sleep(200);
    }
    console.warn('   ⚠ Page ready timeout');
    return false;
}

async function waitForUrlContaining(driver, substring, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const url = await driver.getCurrentUrl();
            if (url.includes(substring)) return url;
        } catch {
            // retry
        }
        await sleep(500);
    }
    return null;
}

async function waitForUrlNotContaining(driver, substring, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const url = await driver.getCurrentUrl();
            if (!url.includes(substring)) return url;
        } catch {
            // retry
        }
        await sleep(500);
    }
    return null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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
                    } catch {
                        // ignore
                    }
                }
                await sleep(500);
            }
        }
    } catch {
        // Server not running or doesn't support /sessions — that's fine
    }
}

// --- Flow steps --------------------------------------------------------------

/**
 * Step 1: Authenticate with the dev box if OAuth is required.
 * Navigates to the dev box root and handles any OAuth login form.
 */
async function authenticateDevBox(driver) {
    console.log('\n🔐 Step 1: Authenticate with dev box');
    console.log(`   Navigating to ${devBoxUrl}/`);

    await driver.get(devBoxUrl + '/');
    await waitForPageReady(driver);
    await screenshot(driver, 'auth-landing');

    const currentUrl = await driver.getCurrentUrl();
    console.log(`   Current URL: ${currentUrl}`);

    // Check if we landed on an OAuth/login page
    // Common patterns: URL contains 'login', 'auth', 'oauth', or page has a login form
    const isLoginPage = currentUrl.includes('login') || currentUrl.includes('auth') || currentUrl.includes('oauth');

    if (isLoginPage && devBoxUsername && devBoxPassword) {
        console.log('   OAuth login page detected, filling credentials...');

        // Try common login form patterns
        const usernameSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]', '#username', '#email'];
        const passwordSelectors = ['input[name="password"]', 'input[type="password"]', '#password'];
        const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', '#login-button', '.login-button'];

        let usernameInput = null;
        for (const sel of usernameSelectors) {
            try {
                usernameInput = await driver.findElement(By.css(sel));
                break;
            } catch {
                continue;
            }
        }

        let passwordInput = null;
        for (const sel of passwordSelectors) {
            try {
                passwordInput = await driver.findElement(By.css(sel));
                break;
            } catch {
                continue;
            }
        }

        if (usernameInput && passwordInput) {
            await usernameInput.clear();
            await usernameInput.sendKeys(devBoxUsername);
            await passwordInput.clear();
            await passwordInput.sendKeys(devBoxPassword);
            await screenshot(driver, 'auth-filled');

            // Submit the form
            let submitted = false;
            for (const sel of submitSelectors) {
                try {
                    const btn = await driver.findElement(By.css(sel));
                    await btn.click();
                    submitted = true;
                    break;
                } catch {
                    continue;
                }
            }

            if (!submitted) {
                // Try submitting the form directly
                try {
                    await passwordInput.sendKeys(selenium.Key.RETURN);
                    submitted = true;
                } catch {
                    console.warn('   ⚠ Could not submit login form');
                }
            }

            if (submitted) {
                await waitForPageReady(driver);
                const afterLoginUrl = await driver.getCurrentUrl();
                console.log(`   After login: ${afterLoginUrl}`);
                await screenshot(driver, 'auth-complete');
            }
        } else {
            console.warn('   ⚠ Could not find login form fields. Proceeding — auth may already be established.');
        }
    } else if (isLoginPage) {
        console.warn('   ⚠ Login page detected but no credentials provided.');
        console.warn('     Set DEV_BOX_USERNAME and DEV_BOX_PASSWORD env vars.');
    } else {
        console.log('   ✓ No login page detected — already authenticated or no auth required.');
    }
}

/**
 * Step 2: Navigate to the subscriptions page on the dev box.
 */
async function navigateToSubscriptions(driver) {
    console.log('\n📋 Step 2: Navigate to subscriptions page');
    console.log(`   URL: ${subscriptionsUrl}`);

    await driver.get(subscriptionsUrl);
    await waitForPageReady(driver);

    // Wait extra for subscription page JS to initialise
    await sleep(2000);

    const currentUrl = await driver.getCurrentUrl();
    console.log(`   Current URL: ${currentUrl}`);
    await screenshot(driver, 'subscriptions-page');

    return currentUrl;
}

/**
 * Step 3: Select a subscription plan.
 * Tries to find and click a plan selection button.
 */
async function selectPlan(driver) {
    console.log('\n💳 Step 3: Select a subscription plan');

    // Common selectors for plan/price buttons on the subscription page
    // The exact selectors depend on the subscription frontend implementation
    const planSelectors = [
        // Annual plan buttons (usually preferred for testing)
        '[data-testid="plan-annual"]',
        '[data-testid="plan-yearly"]',
        '[data-testid="yearly-plan-button"]',
        'button[data-plan="annual"]',
        'button[data-plan="yearly"]',
        // Monthly plan buttons
        '[data-testid="plan-monthly"]',
        '[data-testid="monthly-plan-button"]',
        'button[data-plan="monthly"]',
        // Generic plan/subscribe buttons
        '[data-testid="subscribe-button"]',
        '[data-testid="purchase-button"]',
        '.plan-button',
        '.subscribe-button',
        // Fallback: any button with plan-related text
    ];

    let planButton = null;
    let selectedSelector = '';

    for (const sel of planSelectors) {
        try {
            planButton = await driver.findElement(By.css(sel));
            selectedSelector = sel;
            break;
        } catch {
            continue;
        }
    }

    // Fallback: find buttons by text content
    if (!planButton) {
        console.log('   Trying text-based button search...');
        const buttons = await driver.findElements(By.css('button'));
        for (const btn of buttons) {
            try {
                const text = await btn.getText();
                const lower = text.toLowerCase();
                if (
                    lower.includes('subscribe') ||
                    lower.includes('get privacy pro') ||
                    lower.includes('start') ||
                    lower.includes('annual') ||
                    lower.includes('yearly') ||
                    lower.includes('monthly')
                ) {
                    planButton = btn;
                    selectedSelector = `button[text="${text}"]`;
                    break;
                }
            } catch {
                continue;
            }
        }
    }

    if (!planButton) {
        console.error('   ❌ Could not find a plan selection button.');
        console.error('     The subscription page may not have loaded correctly,');
        console.error('     or the button selectors need updating for the current frontend.');
        await screenshot(driver, 'plan-selection-failed');
        return false;
    }

    console.log(`   Found plan button: ${selectedSelector}`);
    await screenshot(driver, 'before-plan-click');

    await planButton.click();
    console.log('   ✓ Plan button clicked');

    // Wait for the subscription flow to process
    // The native side creates an account and returns a redirect with token
    await sleep(3000);
    await screenshot(driver, 'after-plan-click');

    return true;
}

/**
 * Step 4: Wait for redirect to the fake payment page on payment-company.site.
 */
async function waitForPaymentPage(driver) {
    console.log('\n🏦 Step 4: Wait for redirect to payment page');
    console.log(`   Expecting redirect to: ${paymentPageBase}`);

    // The flow is:
    // 1. Native subscriptionSelected creates account
    // 2. Returns PurchaseUpdate(type: "redirect", token: "...")
    // 3. Frontend JS redirects to the payment page (normally Stripe, now our fake)
    const paymentUrl = await waitForUrlContaining(driver, 'payment-company.site', 30000);

    if (!paymentUrl) {
        // Check if we ended up somewhere unexpected
        const currentUrl = await driver.getCurrentUrl();
        console.error(`   ❌ Timed out waiting for payment page redirect.`);
        console.error(`      Current URL: ${currentUrl}`);

        if (currentUrl.includes('stripe.com')) {
            console.error('      ⚠ Redirected to real Stripe! The dev box frontend needs to be configured');
            console.error('        to redirect to payment-company.site instead of Stripe in test mode.');
        }
        await screenshot(driver, 'payment-redirect-failed');
        return false;
    }

    console.log(`   ✓ Arrived at payment page: ${paymentUrl}`);

    // Verify token is present
    const url = new URL(paymentUrl);
    const token = url.searchParams.get('token');
    const returnURL = url.searchParams.get('returnURL') || url.searchParams.get('returnUrl');

    console.log(`   Token present: ${token ? 'yes (' + token.substring(0, 8) + '...)' : 'NO'}`);
    console.log(`   Return URL present: ${returnURL ? 'yes' : 'NO'}`);

    await waitForPageReady(driver);
    await screenshot(driver, 'payment-page');

    return true;
}

/**
 * Step 5: Complete the fake payment by clicking "Pay" on payment-company.site.
 */
async function completeFakePayment(driver) {
    console.log('\n✅ Step 5: Complete fake payment');

    // If autoPay is enabled, the page auto-submits. Just wait for redirect.
    if (useAutoPay) {
        console.log('   Auto-pay mode — waiting for automatic redirect...');
    } else {
        // Click the Pay button
        try {
            const payButton = await driver.findElement(By.id('pay-button'));
            console.log('   Clicking "Pay & Subscribe" button...');
            await payButton.click();
        } catch (e) {
            console.error(`   ❌ Could not find or click pay button: ${e.message}`);
            await screenshot(driver, 'pay-button-failed');
            return false;
        }
    }

    // Wait for redirect back to the dev box
    console.log('   Waiting for redirect back to dev box...');
    const returnUrl = await waitForUrlNotContaining(driver, 'payment-company.site', 30000);

    if (!returnUrl) {
        const currentUrl = await driver.getCurrentUrl();
        console.error(`   ❌ Timed out waiting for redirect back from payment page.`);
        console.error(`      Current URL: ${currentUrl}`);
        await screenshot(driver, 'return-redirect-failed');
        return false;
    }

    console.log(`   ✓ Redirected back: ${returnUrl}`);
    await waitForPageReady(driver);
    await screenshot(driver, 'after-payment-return');

    return true;
}

/**
 * Step 6: Verify subscription completion.
 * The subscription frontend should call completeStripePayment on the native side,
 * and the page should show a success/welcome state.
 */
async function verifyCompletion(driver) {
    console.log('\n🎉 Step 6: Verify subscription completion');

    // Wait for the page to settle after the completeStripePayment call
    await sleep(3000);
    await waitForPageReady(driver);

    const currentUrl = await driver.getCurrentUrl();
    console.log(`   Current URL: ${currentUrl}`);

    // Check for common success indicators
    const successIndicators = [
        // URL-based
        () => currentUrl.includes('welcome'),
        () => currentUrl.includes('success'),
        () => currentUrl.includes('activation'),
    ];

    let isSuccess = successIndicators.some((check) => check());

    // Also check page content for success messages
    if (!isSuccess) {
        try {
            const pageText = await driver.executeScript('return document.body?.innerText || ""');
            const lowerText = (pageText || '').toLowerCase();
            isSuccess =
                lowerText.includes('welcome') ||
                lowerText.includes('subscription active') ||
                lowerText.includes('you are subscribed') ||
                lowerText.includes('thank you') ||
                lowerText.includes('privacy pro');
        } catch {
            // ignore
        }
    }

    await screenshot(driver, 'completion');

    if (isSuccess) {
        console.log('   ✓ Subscription appears to be successfully completed!');
    } else {
        console.log('   ⚠ Could not confirm subscription success from page content.');
        console.log('     This may be expected if the completion page has not loaded yet,');
        console.log('     or the success indicators need updating.');
    }

    return isSuccess;
}

// --- Main --------------------------------------------------------------------

console.log('═══════════════════════════════════════════════════════════');
console.log('  DuckDuckGo Subscription Payment Flow Automation');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Dev box:         ${devBoxUrl}`);
console.log(`  Payment page:    ${paymentPageBase}`);
console.log(`  WebDriver:       ${serverUrl}`);
console.log(`  Auto-pay:        ${useAutoPay}`);
console.log(`  Screenshots:     ${takeScreenshots}`);
console.log('═══════════════════════════════════════════════════════════');

await cleanupExistingSessions();

let driver;
try {
    driver = await new selenium.Builder().usingServer(serverUrl).withCapabilities({ browserName: 'duckduckgo' }).build();

    console.log('\n✓ WebDriver session created');

    // Step 1: Authenticate with dev box
    await authenticateDevBox(driver);

    // Step 2: Navigate to subscriptions page
    await navigateToSubscriptions(driver);

    // Step 3: Select a plan
    const planSelected = await selectPlan(driver);
    if (!planSelected) {
        console.error('\n❌ FAILED: Could not select a plan. Aborting.');
        process.exit(1);
    }

    // Step 4: Wait for redirect to fake payment page
    const paymentReached = await waitForPaymentPage(driver);
    if (!paymentReached) {
        console.error('\n❌ FAILED: Did not reach the payment page. Aborting.');
        process.exit(1);
    }

    // Step 5: Complete the fake payment
    const paymentCompleted = await completeFakePayment(driver);
    if (!paymentCompleted) {
        console.error('\n❌ FAILED: Payment completion failed. Aborting.');
        process.exit(1);
    }

    // Step 6: Verify completion
    const success = await verifyCompletion(driver);

    console.log('\n═══════════════════════════════════════════════════════════');
    if (success) {
        console.log('  ✅ SUBSCRIPTION FLOW COMPLETED SUCCESSFULLY');
    } else {
        console.log('  ⚠  SUBSCRIPTION FLOW COMPLETED (verification inconclusive)');
    }
    console.log('═══════════════════════════════════════════════════════════');

    if (keepOpen) {
        console.log('\nBrowser will stay open. Press Ctrl+C to quit.');
        await new Promise(() => {});
    }
} catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.message.includes('Session is already started') || error.message.includes('SessionNotCreatedError')) {
        console.error('\n💡 Tip: There may be an existing session. Try:');
        console.error('   npm run driver:cleanup');
        console.error('   Then restart the driver: npm run driver:macos');
    }
    process.exit(1);
} finally {
    if (driver && !keepOpen) {
        try {
            await driver.quit();
        } catch {
            // ignore
        }
    }
}
