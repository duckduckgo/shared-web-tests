/**
 * Investigate why "To secure checkout" button is greyed out on iOS
 * but works in Safari
 */

import { createRequire } from 'node:module';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    // .env file doesn't exist
}

const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');
const { By, until } = selenium;

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';
const platform = process.env.PLATFORM || process.env.TARGET_PLATFORM || 'unknown';
const nintendoEmail = process.env.NINTENDO_EMAIL;
const nintendoPassword = process.env.NINTENDO_PASSWORD;

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPageReady(driver, timeout = 15000) {
    try {
        await driver.wait(async () => {
            const readyState = await driver.executeScript('return document.readyState');
            return readyState === 'complete';
        }, timeout);
        await sleep(1000);
        return true;
    } catch {
        return false;
    }
}

// ============ Main Investigation ============

let driver;
try {
    console.log('\n🔍 Investigating "To secure checkout" button issue');
    console.log('================================================');
    console.log(`Platform: ${platform}`);
    console.log(`WebDriver: ${serverUrl}`);
    console.log(`Login: ${nintendoEmail ? nintendoEmail.substring(0, 3) + '***' : 'Not configured'}\n`);

    driver = await new selenium.Builder()
        .usingServer(serverUrl)
        .withCapabilities({ browserName: 'duckduckgo' })
        .build();

    // Start console capture early
    await driver.executeScript(`
        window.__consoleCapture = { logs: [], errors: [] };
        const origLog = console.log;
        const origError = console.error;
        const origWarn = console.warn;
        console.log = (...args) => { window.__consoleCapture.logs.push({ level: 'log', msg: args.map(String).join(' ') }); origLog.apply(console, args); };
        console.error = (...args) => { window.__consoleCapture.errors.push({ level: 'error', msg: args.map(String).join(' ') }); origError.apply(console, args); };
        console.warn = (...args) => { window.__consoleCapture.logs.push({ level: 'warn', msg: args.map(String).join(' ') }); origWarn.apply(console, args); };
        window.onerror = (msg, src, line, col, err) => { window.__consoleCapture.errors.push({ level: 'error', msg: msg + ' at ' + src + ':' + line }); };
    `);

    // Step 0: Login to Nintendo Account
    if (nintendoEmail && nintendoPassword) {
        console.log('[Step 0] Logging in to Nintendo Account...');
        await driver.get('https://accounts.nintendo.com/login');
        await waitForPageReady(driver);
        await sleep(2000);

        // Fill email
        const emailInput = await driver.findElement(By.css('input[placeholder*="Email"], input[placeholder*="Sign-In"], input[name="loginId"], input#loginId')).catch(() => null);
        if (emailInput) {
            await emailInput.clear();
            await emailInput.sendKeys(nintendoEmail);
            console.log('   ✓ Entered email');
        }

        // Fill password
        const passwordInput = await driver.findElement(By.css('input[type="password"]')).catch(() => null);
        if (passwordInput) {
            await passwordInput.clear();
            await passwordInput.sendKeys(nintendoPassword);
            console.log('   ✓ Entered password');
        }

        // Click login
        const loginBtn = await driver.findElement(By.css('button[type="submit"]')).catch(() => null);
        if (loginBtn) {
            await loginBtn.click();
            console.log('   ✓ Clicked login');
        }

        await waitForPageReady(driver);
        
        // Wait for potential 2FA
        let url = await driver.getCurrentUrl();
        if (url.includes('challenge')) {
            console.log('   ⏳ Waiting for 2FA verification (manual)...');
            for (let i = 0; i < 120; i++) {
                await sleep(2000);
                url = await driver.getCurrentUrl();
                if (!url.includes('challenge')) {
                    console.log('   ✓ 2FA completed');
                    break;
                }
                if (i % 15 === 0 && i > 0) console.log(`   ⏳ Still waiting... (${i * 2}s)`);
            }
        }
        console.log('   ✓ Login completed');
    } else {
        console.log('[Step 0] Skipping login (no credentials)');
    }

    // Step 1: Navigate to product page and add to cart
    console.log('\n[Step 1] Adding Alarmo to cart...');
    await driver.get('https://www.nintendo.com/us/store/products/nintendo-sound-clock-alarmo-121311/');
    await waitForPageReady(driver);
    await sleep(3000);

    // Dismiss any regional modal
    for (let i = 0; i < 5; i++) {
        const dismissed = await driver.executeScript(`
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                if (btn.textContent?.includes('Stay here')) {
                    btn.click();
                    return true;
                }
            }
            return false;
        `);
        if (!dismissed) break;
        await sleep(1000);
    }

    // Try to add to cart
    const addResult = await driver.executeScript(`
        const addBtn = Array.from(document.querySelectorAll('button')).find(b => 
            b.textContent?.toLowerCase().includes('add to cart')
        );
        if (addBtn && !addBtn.disabled) {
            addBtn.click();
            return { clicked: true, buttonText: addBtn.textContent?.trim() };
        }
        return { clicked: false, allButtons: Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(t => t).slice(0, 10) };
    `);
    console.log('   Add to cart:', addResult);
    await sleep(3000);

    // Step 2: Navigate to cart
    console.log('\n[Step 2] Navigating to cart...');
    await driver.get('https://www.nintendo.com/us/cart/');
    await waitForPageReady(driver);
    await sleep(3000);

    // Dismiss regional modal persistently
    for (let i = 0; i < 10; i++) {
        const dismissed = await driver.executeScript(`
            const btn = Array.from(document.querySelectorAll('button')).find(b => 
                b.textContent?.trim() === 'Stay here'
            );
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        `);
        if (!dismissed) break;
        await sleep(800);
    }
    await sleep(2000);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await saveScreenshot(driver, `investigate-cart-${timestamp}.png`);

    // Step 3: Analyze the checkout button
    console.log('\n[Step 3] Analyzing "To secure checkout" button...');
    
    const buttonAnalysis = await driver.executeScript(`
        // Find all buttons that might be the checkout button
        const allButtons = Array.from(document.querySelectorAll('button'));
        const checkoutButtons = allButtons.filter(b => {
            const text = (b.textContent || b.innerText || '').toLowerCase();
            return text.includes('checkout') || text.includes('secure') || text.includes('payment');
        });

        const results = checkoutButtons.map(btn => {
            const computed = window.getComputedStyle(btn);
            const rect = btn.getBoundingClientRect();
            
            // Get the full button HTML for debugging
            const outerHTML = btn.outerHTML.substring(0, 500);
            
            return {
                text: btn.textContent?.trim(),
                disabled: btn.disabled,
                ariaDisabled: btn.getAttribute('aria-disabled'),
                classList: Array.from(btn.classList),
                id: btn.id,
                name: btn.name,
                type: btn.type,
                // Visual state
                opacity: computed.opacity,
                pointerEvents: computed.pointerEvents,
                cursor: computed.cursor,
                backgroundColor: computed.backgroundColor,
                color: computed.color,
                filter: computed.filter,
                // Position
                visible: rect.width > 0 && rect.height > 0,
                rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
                // Data attributes
                dataAttributes: Object.fromEntries(
                    Array.from(btn.attributes)
                        .filter(a => a.name.startsWith('data-'))
                        .map(a => [a.name, a.value])
                ),
                // All attributes for debugging
                allAttributes: Object.fromEntries(
                    Array.from(btn.attributes).map(a => [a.name, a.value.substring(0, 100)])
                ),
                // Parent info
                parentClasses: btn.parentElement?.className,
                // Form validation
                formId: btn.form?.id,
                formValid: btn.form?.checkValidity?.(),
                // HTML snippet
                outerHTML
            };
        });

        // Also find all buttons with "To" in text (for "To secure checkout")
        const toButtons = allButtons.filter(b => {
            const text = (b.textContent || '').toLowerCase();
            return text.includes('to secure') || text.includes('to payment');
        }).map(btn => ({
            text: btn.textContent?.trim(),
            disabled: btn.disabled,
            classList: Array.from(btn.classList),
            opacity: window.getComputedStyle(btn).opacity
        }));

        return {
            totalButtons: allButtons.length,
            checkoutButtonsFound: checkoutButtons.length,
            buttons: results,
            toButtons,
            allButtonTexts: allButtons.map(b => b.textContent?.trim()).filter(t => t && t.length < 50).slice(0, 30)
        };
    `);

    console.log('\n📊 Button Analysis:');
    console.log(JSON.stringify(buttonAnalysis, null, 2));

    // Step 4: Check for JavaScript errors and console logs
    console.log('\n[Step 4] Checking for JavaScript errors...');
    
    const jsErrors = await driver.executeScript(`
        // Check for any error messages in the DOM
        const errorElements = document.querySelectorAll('.error, .error-message, [class*="error"], [role="alert"]');
        const errors = Array.from(errorElements).map(el => ({
            text: el.textContent?.trim()?.substring(0, 200),
            className: el.className,
            visible: el.offsetParent !== null
        })).filter(e => e.text && e.visible);

        // Check for validation messages
        const validationMessages = [];
        document.querySelectorAll('input, select, textarea').forEach(input => {
            if (input.validationMessage) {
                validationMessages.push({
                    name: input.name || input.id,
                    message: input.validationMessage
                });
            }
        });

        // Check localStorage/sessionStorage for any cart state
        let cartState = {};
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key?.toLowerCase().includes('cart') || key?.toLowerCase().includes('checkout')) {
                    cartState[key] = localStorage.getItem(key)?.substring(0, 500);
                }
            }
        } catch {}

        return {
            domErrors: errors,
            validationMessages,
            cartState,
            documentReadyState: document.readyState,
            url: window.location.href
        };
    `);

    console.log('\n📋 Page State:');
    console.log(JSON.stringify(jsErrors, null, 2));

    // Step 5: Check for any blocking overlays/modals
    console.log('\n[Step 5] Checking for blocking elements...');
    
    const blockingElements = await driver.executeScript(`
        const blocking = [];
        
        // Check for modals
        const modals = document.querySelectorAll('[role="dialog"], .modal, [class*="modal"], [class*="overlay"]');
        modals.forEach(modal => {
            const style = window.getComputedStyle(modal);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
                blocking.push({
                    type: 'modal',
                    className: modal.className,
                    text: modal.textContent?.substring(0, 200),
                    zIndex: style.zIndex
                });
            }
        });

        // Check for loading spinners
        const spinners = document.querySelectorAll('[class*="loading"], [class*="spinner"], [aria-busy="true"]');
        spinners.forEach(spinner => {
            const style = window.getComputedStyle(spinner);
            if (style.display !== 'none') {
                blocking.push({
                    type: 'loading',
                    className: spinner.className
                });
            }
        });

        return blocking;
    `);

    console.log('\n🚧 Blocking Elements:');
    console.log(JSON.stringify(blockingElements, null, 2));

    // Step 6: Check network/API state that might affect the button
    console.log('\n[Step 6] Checking for cart items and validation requirements...');
    
    const cartValidation = await driver.executeScript(`
        // Look for cart items
        const cartItems = document.querySelectorAll('[class*="cart-item"], [class*="line-item"], [data-testid*="cart"]');
        
        // Look for any required fields that might be empty
        const requiredFields = [];
        document.querySelectorAll('[required], [aria-required="true"]').forEach(field => {
            requiredFields.push({
                name: field.name || field.id || field.placeholder,
                value: field.value ? '(has value)' : '(empty)',
                type: field.type
            });
        });

        // Look for any checkout-related data attributes
        const checkoutData = {};
        document.querySelectorAll('[data-checkout], [data-cart], [data-testid*="checkout"]').forEach(el => {
            checkoutData[el.tagName + '.' + el.className] = Array.from(el.attributes)
                .filter(a => a.name.startsWith('data-'))
                .map(a => a.name + '=' + a.value);
        });

        // Check if there's a region mismatch warning
        const regionWarnings = Array.from(document.querySelectorAll('*')).filter(el => {
            const text = el.textContent?.toLowerCase() || '';
            return text.includes('region') && (text.includes('different') || text.includes('mismatch') || text.includes('select'));
        }).map(el => el.textContent?.substring(0, 100));

        return {
            cartItemCount: cartItems.length,
            requiredFields,
            checkoutData,
            regionWarnings: [...new Set(regionWarnings)].slice(0, 5),
            bodyClasses: document.body.className
        };
    `);

    console.log('\n🛒 Cart/Validation State:');
    console.log(JSON.stringify(cartValidation, null, 2));

    // Step 7: Try clicking the button and capture any response
    console.log('\n[Step 7] Attempting to click the checkout button...');
    
    const clickResult = await driver.executeScript(`
        const btn = Array.from(document.querySelectorAll('button')).find(b => 
            b.textContent?.toLowerCase().includes('secure checkout')
        );
        
        if (!btn) return { found: false };
        
        // Capture any events that fire
        const events = [];
        const originalAlert = window.alert;
        window.alert = (msg) => events.push({ type: 'alert', msg });
        
        try {
            btn.click();
        } catch (e) {
            events.push({ type: 'error', msg: e.message });
        }
        
        window.alert = originalAlert;
        
        return {
            found: true,
            buttonDisabled: btn.disabled,
            events,
            urlAfter: window.location.href
        };
    `);

    console.log('\n🖱️ Click Result:');
    console.log(JSON.stringify(clickResult, null, 2));

    await sleep(2000);
    await saveScreenshot(driver, `investigate-after-click-${timestamp}.png`);

    const finalUrl = await driver.getCurrentUrl();
    console.log('\n📍 Final URL:', finalUrl);

    // Step 8: Get captured console logs
    console.log('\n[Step 8] Captured console logs...');
    const consoleLogs = await driver.executeScript(`
        return window.__consoleCapture || { logs: [], errors: [] };
    `);
    
    if (consoleLogs.errors?.length > 0) {
        console.log('\n🔴 JavaScript Errors:');
        consoleLogs.errors.slice(0, 20).forEach(e => console.log(`   ${e.msg?.substring(0, 200)}`));
    }
    if (consoleLogs.logs?.length > 0) {
        console.log('\n📋 Console Logs (last 20):');
        consoleLogs.logs.slice(-20).forEach(l => console.log(`   [${l.level}] ${l.msg?.substring(0, 200)}`));
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 INVESTIGATION SUMMARY');
    console.log('='.repeat(60));
    
    // Find the "To secure checkout" button specifically
    const secureCheckoutBtn = buttonAnalysis.buttons?.find(b => 
        b.text?.toLowerCase().includes('to secure checkout') || 
        b.text?.toLowerCase().includes('secure checkout')
    ) || buttonAnalysis.toButtons?.[0];
    
    if (secureCheckoutBtn) {
        console.log('\n"To secure checkout" button state:');
        console.log(`  - text: "${secureCheckoutBtn.text}"`);
        console.log(`  - disabled attribute: ${secureCheckoutBtn.disabled}`);
        console.log(`  - aria-disabled: ${secureCheckoutBtn.ariaDisabled || 'null'}`);
        console.log(`  - opacity: ${secureCheckoutBtn.opacity}`);
        console.log(`  - pointer-events: ${secureCheckoutBtn.pointerEvents || 'n/a'}`);
        console.log(`  - cursor: ${secureCheckoutBtn.cursor || 'n/a'}`);
        console.log(`  - classes: ${secureCheckoutBtn.classList?.join(', ')}`);
        console.log(`  - background-color: ${secureCheckoutBtn.backgroundColor || 'n/a'}`);
        
        const isDisabled = secureCheckoutBtn.disabled || 
                          secureCheckoutBtn.ariaDisabled === 'true' || 
                          parseFloat(secureCheckoutBtn.opacity) < 0.6 ||
                          secureCheckoutBtn.pointerEvents === 'none';
        
        if (isDisabled) {
            console.log('\n❌ BUTTON IS DISABLED/GREYED OUT - BUG CONFIRMED');
            console.log('\n🔍 Possible causes to investigate:');
            if (blockingElements.length > 0) {
                console.log('  - Modal/overlay may be blocking interactions');
            }
            if (cartValidation.regionWarnings?.length > 0) {
                console.log('  - Region mismatch may be affecting the page');
            }
            if (consoleLogs.errors?.length > 0) {
                console.log('  - JavaScript errors may be preventing button activation');
            }
            if (cartValidation.cartItemCount === 0) {
                console.log('  - Cart may appear empty to the site');
            }
            console.log('\n💡 Compare with Safari to identify the root cause:');
            console.log('   - Does Safari have the same console errors?');
            console.log('   - Does Safari receive different API responses?');
            console.log('   - Are cookies/storage being set differently?');
        } else {
            console.log('\n✅ Button appears enabled');
        }
    } else {
        console.log('\n⚠️ Could not find "To secure checkout" button');
        console.log('Available buttons:', buttonAnalysis.allButtonTexts?.join(', '));
    }
    
    if (jsErrors.domErrors?.length > 0) {
        console.log('\n🔴 DOM Errors found:');
        jsErrors.domErrors.forEach(e => console.log(`   - ${e.text}`));
    }

    console.log('\n✅ Browser will stay open for manual inspection. Press Ctrl+C to quit.');
    await new Promise(() => {});

} catch (error) {
    console.error('\n❌ Investigation Error:', error.message);
    process.exit(1);
} finally {
    // Don't quit - keep browser open
}
