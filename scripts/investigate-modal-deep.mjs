#!/usr/bin/env node
/**
 * Deep investigation of the Nintendo modal
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

async function executeScript(sessionId, script, ...args) {
    const response = await fetch(`${serverUrl}/session/${sessionId}/execute/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            script: `return (function() { ${script} })()`,
            args
        })
    });
    const data = await response.json();
    if (data.value?.error) {
        throw new Error(data.value.message);
    }
    return data.value;
}

async function navigateTo(sessionId, url) {
    const response = await fetch(`${serverUrl}/session/${sessionId}/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });
    return response.ok;
}

async function takeScreenshot(sessionId, filename) {
    const response = await fetch(`${serverUrl}/session/${sessionId}/screenshot`);
    const data = await response.json();
    if (data.value) {
        const screenshotsDir = join(scriptsDir, '..', 'screenshots');
        await mkdir(screenshotsDir, { recursive: true });
        const filepath = join(screenshotsDir, filename);
        await writeFile(filepath, Buffer.from(data.value, 'base64'));
        console.log(`📸 Screenshot: ${filepath}`);
        return filepath;
    }
    return null;
}

async function createSession() {
    const response = await fetch(`${serverUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            capabilities: {
                alwaysMatch: { browserName: 'duckduckgo' },
                firstMatch: [{}]
            }
        })
    });
    const data = await response.json();
    return data.value?.sessionId || data.sessionId;
}

async function main() {
    console.log('🔍 Deep Modal Investigation');
    console.log(`   Server: ${serverUrl}\n`);

    const sessionId = await createSession();
    if (!sessionId) {
        console.error('Failed to create session');
        process.exit(1);
    }
    console.log(`   Session: ${sessionId}\n`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Navigate to Nintendo cart
    console.log('📍 Navigating to Nintendo US cart...');
    await navigateTo(sessionId, 'https://www.nintendo.com/us/cart/');
    
    // Wait for page load
    console.log('   Waiting for page load (10s)...');
    await new Promise(r => setTimeout(r, 10000));
    
    await takeScreenshot(sessionId, `modal-deep-1-${timestamp}.png`);

    // Get ALL modals/dialogs HTML
    console.log('\n📋 Getting modal HTML...');
    const modalHtml = await executeScript(sessionId, `
        const dialogs = document.querySelectorAll('[role="dialog"]');
        const results = [];
        
        for (const dialog of dialogs) {
            const style = window.getComputedStyle(dialog);
            results.push({
                outerHTML: dialog.outerHTML,
                className: dialog.className,
                id: dialog.id,
                display: style.display,
                visibility: style.visibility,
                childCount: dialog.children.length,
                textContent: dialog.textContent,
                innerText: dialog.innerText
            });
        }
        
        return results;
    `);

    if (modalHtml.length === 0) {
        console.log('   No modals found with [role="dialog"]');
        
        // Try other modal selectors
        const otherModals = await executeScript(sessionId, `
            const selectors = [
                '.modal', 
                '[class*="modal"]', 
                '[class*="Modal"]',
                '[class*="dialog"]',
                '[class*="Dialog"]',
                '[class*="overlay"]',
                '[class*="Overlay"]'
            ];
            
            for (const sel of selectors) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const style = window.getComputedStyle(el);
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                        return {
                            selector: sel,
                            outerHTML: el.outerHTML.substring(0, 5000),
                            className: el.className,
                            textContent: el.textContent?.substring(0, 500)
                        };
                    }
                }
            }
            return null;
        `);
        
        if (otherModals) {
            console.log(`   Found modal with selector: ${otherModals.selector}`);
            console.log(`   Class: ${otherModals.className}`);
            console.log(`   Text: "${otherModals.textContent}"`);
            console.log('\n   HTML (first 2000 chars):');
            console.log(otherModals.outerHTML?.substring(0, 2000));
        }
    } else {
        console.log(`   Found ${modalHtml.length} dialog(s):\n`);
        
        for (let i = 0; i < modalHtml.length; i++) {
            const m = modalHtml[i];
            console.log(`   === Dialog ${i + 1} ===`);
            console.log(`   Class: ${m.className}`);
            console.log(`   ID: ${m.id || '(none)'}`);
            console.log(`   Display: ${m.display}`);
            console.log(`   Visibility: ${m.visibility}`);
            console.log(`   Children: ${m.childCount}`);
            console.log(`   textContent length: ${m.textContent?.length || 0}`);
            console.log(`   innerText length: ${m.innerText?.length || 0}`);
            console.log(`   textContent: "${m.textContent?.substring(0, 200)}"`);
            console.log(`   innerText: "${m.innerText?.substring(0, 200)}"`);
            console.log('\n   Full outerHTML:');
            console.log('   ' + '='.repeat(60));
            console.log(m.outerHTML);
            console.log('   ' + '='.repeat(60));
            console.log('');
        }
    }

    // Find ALL buttons on the page and their states
    console.log('\n🔘 All buttons on the page:');
    const allButtons = await executeScript(sessionId, `
        const buttons = document.querySelectorAll('button');
        return Array.from(buttons).map((btn, idx) => {
            const rect = btn.getBoundingClientRect();
            const style = window.getComputedStyle(btn);
            return {
                index: idx,
                textContent: btn.textContent?.trim().substring(0, 100),
                innerText: btn.innerText?.trim().substring(0, 100),
                innerHTML: btn.innerHTML?.substring(0, 200),
                className: btn.className,
                id: btn.id,
                disabled: btn.disabled,
                visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                ariaLabel: btn.getAttribute('aria-label'),
                dataTestId: btn.getAttribute('data-testid')
            };
        });
    `);

    console.log(`   Total buttons: ${allButtons.length}`);
    console.log(`   Visible buttons: ${allButtons.filter(b => b.visible).length}`);
    
    // Find buttons that might be modal-related
    const modalButtons = allButtons.filter(b => 
        b.visible && 
        (b.textContent?.length === 0 || 
         b.textContent?.toLowerCase().includes('stay') ||
         b.textContent?.toLowerCase().includes('close') ||
         b.textContent?.toLowerCase().includes('change') ||
         b.ariaLabel?.toLowerCase().includes('close') ||
         b.innerHTML?.includes('svg'))
    );

    console.log(`\n   Potentially modal-related buttons (${modalButtons.length}):`);
    for (const btn of modalButtons.slice(0, 10)) {
        console.log(`\n   Button #${btn.index}:`);
        console.log(`     textContent: "${btn.textContent}"`);
        console.log(`     innerText: "${btn.innerText}"`);
        console.log(`     className: ${btn.className}`);
        console.log(`     ariaLabel: ${btn.ariaLabel}`);
        console.log(`     disabled: ${btn.disabled}`);
        console.log(`     rect: ${JSON.stringify(btn.rect)}`);
        console.log(`     innerHTML: ${btn.innerHTML}`);
    }

    // Find the dialog and get its buttons specifically
    console.log('\n🎯 Buttons inside [role="dialog"]:');
    const dialogButtons = await executeScript(sessionId, `
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return { found: false };
        
        const buttons = dialog.querySelectorAll('button');
        return {
            found: true,
            dialogHTML: dialog.outerHTML,
            buttonCount: buttons.length,
            buttons: Array.from(buttons).map((btn, idx) => {
                const rect = btn.getBoundingClientRect();
                return {
                    index: idx,
                    textContent: btn.textContent,
                    innerText: btn.innerText,
                    outerHTML: btn.outerHTML,
                    className: btn.className,
                    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                    clickable: rect.width > 0 && rect.height > 0
                };
            })
        };
    `);

    if (!dialogButtons.found) {
        console.log('   No dialog found');
    } else {
        console.log(`   Dialog button count: ${dialogButtons.buttonCount}`);
        console.log(`\n   Dialog full HTML:`);
        console.log('   ' + '='.repeat(60));
        console.log(dialogButtons.dialogHTML);
        console.log('   ' + '='.repeat(60));
        
        for (const btn of dialogButtons.buttons) {
            console.log(`\n   Dialog Button #${btn.index}:`);
            console.log(`     textContent: "${btn.textContent}"`);
            console.log(`     innerText: "${btn.innerText}"`);
            console.log(`     outerHTML: ${btn.outerHTML}`);
            console.log(`     rect: ${JSON.stringify(btn.rect)}`);
            console.log(`     clickable: ${btn.clickable}`);
        }
    }

    // Try clicking any button inside the dialog
    console.log('\n🖱️ Attempting to click buttons inside dialog...');
    
    const clickResult = await executeScript(sessionId, `
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return { success: false, reason: 'No dialog found' };
        
        const buttons = dialog.querySelectorAll('button');
        if (buttons.length === 0) return { success: false, reason: 'No buttons in dialog' };
        
        const results = [];
        
        for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            const rect = btn.getBoundingClientRect();
            
            // Record state before click
            const before = {
                dialogVisible: window.getComputedStyle(dialog).display !== 'none',
                url: location.href
            };
            
            try {
                // Try multiple click methods
                btn.click();
                
                // Also dispatch events
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                
                results.push({
                    buttonIndex: i,
                    buttonText: btn.textContent,
                    buttonHTML: btn.outerHTML,
                    clicked: true,
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                });
            } catch (e) {
                results.push({
                    buttonIndex: i,
                    buttonText: btn.textContent,
                    clicked: false,
                    error: e.message
                });
            }
        }
        
        return { success: true, clicks: results };
    `);

    console.log('   Click results:', JSON.stringify(clickResult, null, 2));

    // Wait and check if dialog is still visible
    await new Promise(r => setTimeout(r, 2000));
    
    const afterClick = await executeScript(sessionId, `
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return { dialogFound: false };
        
        const style = window.getComputedStyle(dialog);
        return {
            dialogFound: true,
            display: style.display,
            visibility: style.visibility,
            stillVisible: style.display !== 'none' && style.visibility !== 'hidden',
            textContent: dialog.textContent?.substring(0, 200)
        };
    `);
    
    console.log('\n   After click state:');
    console.log(`     Dialog still visible: ${afterClick.stillVisible}`);
    console.log(`     Display: ${afterClick.display}`);
    console.log(`     Content: "${afterClick.textContent}"`);

    await takeScreenshot(sessionId, `modal-deep-2-after-click-${timestamp}.png`);

    // Try to click by coordinates if we found a button
    if (dialogButtons.found && dialogButtons.buttons.length > 0) {
        const firstButton = dialogButtons.buttons[0];
        if (firstButton.rect.width > 0 && firstButton.rect.height > 0) {
            console.log('\n🎯 Attempting coordinate-based click...');
            const centerX = firstButton.rect.x + firstButton.rect.width / 2;
            const centerY = firstButton.rect.y + firstButton.rect.height / 2;
            console.log(`   Clicking at (${centerX}, ${centerY})`);
            
            const coordClick = await executeScript(sessionId, `
                const x = ${centerX};
                const y = ${centerY};
                const el = document.elementFromPoint(x, y);
                
                if (!el) return { found: false, reason: 'No element at coordinates' };
                
                return {
                    found: true,
                    element: el.tagName,
                    className: el.className,
                    text: el.textContent?.substring(0, 100),
                    outerHTML: el.outerHTML?.substring(0, 300)
                };
            `);
            
            console.log('   Element at coordinates:', JSON.stringify(coordClick, null, 2));
        }
    }

    console.log('\n✅ Investigation complete');
    console.log('   Session kept open for manual inspection');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
