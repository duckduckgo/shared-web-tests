/**
 * Investigate Nintendo checkout modal issue
 * Specifically looking at the "Stay here" button behavior
 */
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');
const { By, until } = selenium;

const serverUrl = 'http://localhost:4444';
const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function screenshot(driver, name) {
    const screenshotsDir = join(scriptsDir, '..', 'screenshots');
    try {
        await mkdir(screenshotsDir, { recursive: true });
        const base64 = await driver.takeScreenshot();
        const filepath = join(screenshotsDir, `investigate-checkout-${name}-${timestamp()}.png`);
        await writeFile(filepath, Buffer.from(base64, 'base64'));
        console.log(`📸 ${filepath}`);
    } catch (e) {
        console.error(`Screenshot error: ${e.message}`);
    }
}

async function cleanup() {
    try {
        const res = await fetch(`${serverUrl}/sessions`);
        const data = await res.json();
        const sessions = data.value || [];
        for (const s of sessions) {
            const id = s.id || s.sessionId || s;
            await fetch(`${serverUrl}/session/${id}`, { method: 'DELETE' });
        }
    } catch {}
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForPageReady(driver, timeout = 15000) {
    try {
        await driver.wait(async () => {
            const rs = await driver.executeScript('return document.readyState');
            return rs === 'complete';
        }, timeout);
        await sleep(1000);
        return true;
    } catch { return false; }
}

await cleanup();

const driver = await new selenium.Builder()
    .usingServer(serverUrl)
    .withCapabilities({ browserName: 'duckduckgo' })
    .build();

try {
    console.log('\n=== Investigating Nintendo Checkout Modal ===\n');
    
    // Go to cart page
    console.log('1. Navigating to cart...');
    await driver.get('https://www.nintendo.com/us/cart/');
    await waitForPageReady(driver);
    await sleep(2000);
    await screenshot(driver, '1-cart-initial');
    
    // Check for modal immediately
    console.log('\n2. Checking initial page state...');
    const initialState = await driver.executeScript(`
        const dialog = document.querySelector('[role="dialog"]');
        const allButtons = Array.from(document.querySelectorAll('button')).map(b => ({
            text: (b.textContent || '').trim().substring(0, 50),
            visible: b.offsetParent !== null,
            rect: b.getBoundingClientRect().toJSON()
        }));
        
        return {
            hasDialog: !!dialog,
            dialogVisible: dialog ? window.getComputedStyle(dialog).display !== 'none' : false,
            dialogText: dialog?.textContent?.substring(0, 500),
            buttons: allButtons.filter(b => b.text && b.visible),
            url: location.href
        };
    `);
    
    console.log('Modal present:', initialState.hasDialog);
    console.log('Modal visible:', initialState.dialogVisible);
    console.log('Current URL:', initialState.url);
    console.log('Visible buttons:');
    initialState.buttons.forEach(b => console.log(`  - "${b.text}"`));
    
    // Now click "To secure checkout"
    console.log('\n3. Clicking "To secure checkout" button...');
    const clickResult = await driver.executeScript(`
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.textContent.includes('secure checkout')) {
                const rect = btn.getBoundingClientRect();
                btn.click();
                return { clicked: true, text: btn.textContent.trim(), rect: rect.toJSON() };
            }
        }
        return { clicked: false };
    `);
    console.log('Click result:', clickResult);
    
    await sleep(3000);
    await screenshot(driver, '2-after-checkout-click');
    
    // Check state after click
    console.log('\n4. Checking state after checkout click...');
    const afterClick = await driver.executeScript(`
        const dialog = document.querySelector('[role="dialog"]');
        const stayHereBtn = Array.from(document.querySelectorAll('button'))
            .find(b => (b.textContent || '').toLowerCase().includes('stay here'));
        const allBtns = Array.from(document.querySelectorAll('button'))
            .filter(b => b.offsetParent !== null)
            .map(b => (b.textContent || '').trim().substring(0, 50));
        
        return {
            url: location.href,
            hasDialog: !!dialog,
            dialogVisible: dialog ? window.getComputedStyle(dialog).display !== 'none' : false,
            dialogHTML: dialog?.outerHTML?.substring(0, 3000),
            stayHereButton: stayHereBtn ? {
                text: stayHereBtn.textContent.trim(),
                visible: stayHereBtn.offsetParent !== null
            } : null,
            allVisibleButtons: allBtns
        };
    `);
    
    console.log('URL after click:', afterClick.url);
    console.log('Dialog present:', afterClick.hasDialog);
    console.log('Dialog visible:', afterClick.dialogVisible);
    console.log('Stay here button:', afterClick.stayHereButton);
    console.log('All visible buttons:', afterClick.allVisibleButtons);
    
    if (afterClick.dialogHTML) {
        console.log('\n=== Dialog HTML ===');
        console.log(afterClick.dialogHTML);
        console.log('=== End Dialog HTML ===\n');
    }
    
    // If there's a Stay here button, investigate what happens when we click it
    if (afterClick.stayHereButton) {
        console.log('\n5. Investigating "Stay here" button behavior...');
        const beforeUrl = await driver.getCurrentUrl();
        
        // Get detailed button info before clicking
        const buttonDetails = await driver.executeScript(`
            const btn = Array.from(document.querySelectorAll('button'))
                .find(b => (b.textContent || '').toLowerCase().includes('stay here'));
            if (!btn) return null;
            
            const style = window.getComputedStyle(btn);
            return {
                text: btn.textContent.trim(),
                type: btn.type,
                disabled: btn.disabled,
                onclick: btn.getAttribute('onclick'),
                hasClickListeners: btn.onclick !== null,
                classes: btn.className,
                zIndex: style.zIndex,
                position: style.position,
                rect: btn.getBoundingClientRect().toJSON()
            };
        `);
        console.log('Button details:', buttonDetails);
        
        // Click the button
        console.log('\n6. Clicking "Stay here"...');
        await driver.executeScript(`
            const btn = Array.from(document.querySelectorAll('button'))
                .find(b => (b.textContent || '').toLowerCase().includes('stay here'));
            if (btn) {
                console.log('[Debug] Clicking Stay here button');
                btn.click();
            }
        `);
        
        await sleep(2000);
        await screenshot(driver, '3-after-stay-here');
        
        const afterStay = await driver.executeScript(`
            const dialog = document.querySelector('[role="dialog"]');
            const stayBtn = Array.from(document.querySelectorAll('button'))
                .find(b => (b.textContent || '').toLowerCase().includes('stay here'));
            
            return {
                url: location.href,
                hasDialog: !!dialog,
                dialogVisible: dialog ? window.getComputedStyle(dialog).display !== 'none' : false,
                stayBtnStillExists: !!stayBtn
            };
        `);
        
        console.log('\nAfter clicking Stay here:');
        console.log('  URL:', afterStay.url);
        console.log('  URL changed:', afterStay.url !== beforeUrl);
        console.log('  Dialog still present:', afterStay.hasDialog);
        console.log('  Dialog still visible:', afterStay.dialogVisible);
        console.log('  Stay here button still exists:', afterStay.stayBtnStillExists);
        
        // If modal still visible, try different dismiss methods
        if (afterStay.dialogVisible) {
            console.log('\n7. Modal still visible - trying alternative dismiss methods...');
            
            // Try pressing Escape
            console.log('  7a. Trying Escape key...');
            await driver.executeScript(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
            await sleep(1000);
            
            const afterEscape = await driver.executeScript(`
                const dialog = document.querySelector('[role="dialog"]');
                return { visible: dialog ? window.getComputedStyle(dialog).display !== 'none' : false };
            `);
            console.log('  After Escape - Modal visible:', afterEscape.visible);
            
            if (afterEscape.visible) {
                // Try clicking backdrop
                console.log('  7b. Trying backdrop click...');
                await driver.executeScript(`
                    const backdrop = document.querySelector('[role="dialog"]')?.parentElement;
                    if (backdrop) {
                        backdrop.click();
                    }
                `);
                await sleep(1000);
                
                const afterBackdrop = await driver.executeScript(`
                    const dialog = document.querySelector('[role="dialog"]');
                    return { visible: dialog ? window.getComputedStyle(dialog).display !== 'none' : false };
                `);
                console.log('  After backdrop click - Modal visible:', afterBackdrop.visible);
            }
            
            await screenshot(driver, '4-after-dismiss-attempts');
        }
    }
    
    // Try one more checkout click
    console.log('\n8. Final checkout attempt...');
    await driver.executeScript(`
        const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.includes('secure checkout'));
        if (btn) btn.click();
    `);
    
    await sleep(3000);
    await screenshot(driver, '5-final-state');
    
    const finalState = await driver.executeScript(`
        return {
            url: location.href,
            title: document.title,
            hasDialog: !!document.querySelector('[role="dialog"]'),
            dialogVisible: document.querySelector('[role="dialog"]') 
                ? window.getComputedStyle(document.querySelector('[role="dialog"]')).display !== 'none' 
                : false
        };
    `);
    
    console.log('\n=== Final State ===');
    console.log('URL:', finalState.url);
    console.log('Title:', finalState.title);
    console.log('Dialog present:', finalState.hasDialog);
    console.log('Dialog visible:', finalState.dialogVisible);
    
    console.log('\n✅ Investigation complete - browser will stay open');
    await new Promise(() => {});
    
} catch (error) {
    console.error('Error:', error.message);
    await screenshot(driver, 'error');
    process.exit(1);
}
