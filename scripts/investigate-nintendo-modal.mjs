#!/usr/bin/env node
/**
 * Investigate Nintendo Region Modal Issue
 * 
 * This script investigates why the "Stay here" click isn't being persisted,
 * focusing on cookies, localStorage, and tracking protection.
 */

import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

async function getExistingSession() {
    try {
        // Try /sessions endpoint first
        const response = await fetch(`${serverUrl}/sessions`);
        const text = await response.text();
        
        // If it returns "HTTP method not allowed", try /status
        if (text.includes('not allowed')) {
            // Try to get session from /status
            const statusResponse = await fetch(`${serverUrl}/status`);
            const statusData = await statusResponse.json();
            console.log('Driver status:', statusData);
            return null;
        }
        
        const data = JSON.parse(text);
        const sessions = data.value || (Array.isArray(data) ? data : []);
        if (sessions.length > 0) {
            return sessions[0].id || sessions[0].sessionId || sessions[0];
        }
    } catch (e) {
        console.error('Session check error:', e.message);
    }
    return null;
}

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

async function getCurrentUrl(sessionId) {
    const response = await fetch(`${serverUrl}/session/${sessionId}/url`);
    const data = await response.json();
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
        const { writeFile, mkdir } = await import('node:fs/promises');
        const { dirname, join } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const scriptsDir = dirname(fileURLToPath(import.meta.url));
        const screenshotsDir = join(scriptsDir, '..', 'screenshots');
        await mkdir(screenshotsDir, { recursive: true });
        const filepath = join(screenshotsDir, filename);
        await writeFile(filepath, Buffer.from(data.value, 'base64'));
        console.log(`📸 Screenshot: ${filepath}`);
        return filepath;
    }
    return null;
}

async function main() {
    console.log('🔍 Nintendo Region Modal Investigation');
    console.log(`   Server: ${serverUrl}\n`);

    // Find existing session
    const sessionId = await getExistingSession();
    if (!sessionId) {
        console.log('No active session. Creating a new one...');
        
        // Create new session
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
        const newSessionId = data.value?.sessionId || data.sessionId;
        if (!newSessionId) {
            console.error('Failed to create session:', data);
            process.exit(1);
        }
        console.log(`   Created session: ${newSessionId}\n`);
        return investigate(newSessionId);
    }

    console.log(`   Session: ${sessionId}\n`);
    return investigate(sessionId);
}

async function investigate(sessionId) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Get current page
    const currentUrl = await getCurrentUrl(sessionId);
    console.log(`📄 Current URL: ${currentUrl}`);
    
    // Navigate to Nintendo US cart page to trigger the modal
    if (!currentUrl.includes('nintendo.com')) {
        console.log('\n   Navigating to Nintendo US cart...');
        await navigateTo(sessionId, 'https://www.nintendo.com/us/cart/');
        await new Promise(r => setTimeout(r, 5000));
    }
    
    await takeScreenshot(sessionId, `investigate-modal-${timestamp}.png`);
    
    // 1. Check for the regional modal
    console.log('\n🪟 Checking for Regional Modal...');
    const modalInfo = await executeScript(sessionId, `
        const modals = document.querySelectorAll('[role="dialog"], .modal, [class*="modal"]');
        const results = [];
        for (const modal of modals) {
            const style = window.getComputedStyle(modal);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
                results.push({
                    selector: modal.id ? '#' + modal.id : modal.className,
                    text: modal.textContent?.substring(0, 200),
                    display: style.display,
                    buttons: Array.from(modal.querySelectorAll('button')).map(b => ({
                        text: b.textContent?.trim(),
                        disabled: b.disabled
                    }))
                });
            }
        }
        return results;
    `);
    
    if (modalInfo.length > 0) {
        console.log(`   Found ${modalInfo.length} visible modal(s):`);
        for (const m of modalInfo) {
            console.log(`   - Selector: ${m.selector}`);
            console.log(`     Text: ${m.text?.substring(0, 100)}...`);
            console.log(`     Buttons: ${m.buttons.map(b => b.text).join(', ')}`);
        }
    } else {
        console.log('   No visible modals found');
    }
    
    // 2. Check cookies
    console.log('\n🍪 Checking Cookies...');
    const cookies = await executeScript(sessionId, `
        return document.cookie.split(';').map(c => {
            const [name, value] = c.trim().split('=');
            return { name, value: value?.substring(0, 50) };
        });
    `);
    
    if (cookies.length === 0) {
        console.log('   ❌ No cookies found! Likely blocked by tracking protection.');
    } else {
        console.log(`   Found ${cookies.length} cookies:`);
        const regionCookies = cookies.filter(c => 
            c.name?.toLowerCase().includes('region') ||
            c.name?.toLowerCase().includes('locale') ||
            c.name?.toLowerCase().includes('country') ||
            c.name?.toLowerCase().includes('geo')
        );
        if (regionCookies.length > 0) {
            console.log('   Region-related cookies:');
            for (const c of regionCookies) {
                console.log(`     - ${c.name}: ${c.value}`);
            }
        } else {
            console.log('   ⚠️ No region-related cookies found');
            console.log('   All cookies:');
            for (const c of cookies.slice(0, 10)) {
                console.log(`     - ${c.name}: ${c.value}`);
            }
            if (cookies.length > 10) {
                console.log(`     ... and ${cookies.length - 10} more`);
            }
        }
    }
    
    // 3. Check localStorage
    console.log('\n📦 Checking localStorage...');
    const storageInfo = await executeScript(sessionId, `
        try {
            const keys = Object.keys(localStorage);
            return {
                accessible: true,
                count: keys.length,
                keys: keys.slice(0, 20),
                regionKeys: keys.filter(k => 
                    k.toLowerCase().includes('region') ||
                    k.toLowerCase().includes('locale') ||
                    k.toLowerCase().includes('country')
                )
            };
        } catch (e) {
            return { accessible: false, error: e.message };
        }
    `);
    
    if (!storageInfo.accessible) {
        console.log(`   ❌ localStorage not accessible: ${storageInfo.error}`);
    } else {
        console.log(`   Found ${storageInfo.count} localStorage keys`);
        if (storageInfo.regionKeys.length > 0) {
            console.log('   Region-related keys:');
            for (const k of storageInfo.regionKeys) {
                const value = await executeScript(sessionId, `return localStorage.getItem('${k}')`);
                console.log(`     - ${k}: ${value?.substring(0, 50)}`);
            }
        } else {
            console.log('   ⚠️ No region-related localStorage keys found');
        }
    }
    
    // 4. Check sessionStorage
    console.log('\n📦 Checking sessionStorage...');
    const sessionStorageInfo = await executeScript(sessionId, `
        try {
            const keys = Object.keys(sessionStorage);
            return {
                accessible: true,
                count: keys.length,
                keys: keys.slice(0, 20)
            };
        } catch (e) {
            return { accessible: false, error: e.message };
        }
    `);
    
    if (!sessionStorageInfo.accessible) {
        console.log(`   ❌ sessionStorage not accessible: ${sessionStorageInfo.error}`);
    } else {
        console.log(`   Found ${sessionStorageInfo.count} sessionStorage keys`);
    }
    
    // 5. Try clicking "Stay here" and see what happens
    console.log('\n🖱️ Attempting to click "Stay here" and observe...');
    
    const beforeCookies = await executeScript(sessionId, `return document.cookie`);
    const beforeStorage = await executeScript(sessionId, `return Object.keys(localStorage).length`);
    
    const clickResult = await executeScript(sessionId, `
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            const text = (btn.textContent || btn.innerText || '').trim();
            if (text === 'Stay here' || text.includes('Stay here')) {
                // Watch for cookie changes
                const cookiesBefore = document.cookie;
                
                btn.click();
                
                return {
                    clicked: true,
                    buttonText: text,
                    cookiesBefore
                };
            }
        }
        return { clicked: false, reason: 'Stay here button not found' };
    `);
    
    if (clickResult.clicked) {
        console.log(`   ✓ Clicked "${clickResult.buttonText}"`);
        
        // Wait and check for changes
        await new Promise(r => setTimeout(r, 2000));
        
        const afterCookies = await executeScript(sessionId, `return document.cookie`);
        const afterStorage = await executeScript(sessionId, `return Object.keys(localStorage).length`);
        
        console.log(`   Cookies before: ${clickResult.cookiesBefore.length} chars`);
        console.log(`   Cookies after: ${afterCookies.length} chars`);
        console.log(`   localStorage before: ${beforeStorage} keys`);
        console.log(`   localStorage after: ${afterStorage} keys`);
        
        if (beforeCookies === afterCookies) {
            console.log('   ⚠️ No cookie changes after click - preference likely not persisted');
        }
        
        // Check if modal is still visible
        const modalStillVisible = await executeScript(sessionId, `
            const modal = document.querySelector('[role="dialog"]');
            if (!modal) return false;
            const style = window.getComputedStyle(modal);
            return style.display !== 'none' && style.visibility !== 'hidden';
        `);
        
        console.log(`   Modal still visible: ${modalStillVisible}`);
        
        await takeScreenshot(sessionId, `investigate-after-click-${timestamp}.png`);
    } else {
        console.log(`   ${clickResult.reason}`);
    }
    
    // 6. Check for third-party cookie blocking indicators
    console.log('\n🔒 Checking for Tracking Protection Indicators...');
    
    // Try to identify tracking-related scripts that might be blocked
    const scriptInfo = await executeScript(sessionId, `
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        const trackerPatterns = [
            'analytics', 'tracking', 'pixel', 'tag', 'gtm', 'segment',
            'facebook', 'google', 'doubleclick', 'adsense'
        ];
        
        return scripts.map(s => ({
            src: s.src,
            blocked: s.readyState === 'error' || !s.complete,
            isTracker: trackerPatterns.some(p => s.src.toLowerCase().includes(p))
        })).filter(s => s.isTracker || s.blocked);
    `);
    
    if (scriptInfo.length > 0) {
        console.log(`   Found ${scriptInfo.length} tracker/blocked scripts:`);
        for (const s of scriptInfo.slice(0, 5)) {
            console.log(`     - ${s.src.substring(0, 60)}... (blocked: ${s.blocked})`);
        }
    }
    
    // 7. Try setting a test cookie to verify if cookies work at all
    console.log('\n🧪 Testing if cookies can be set...');
    const cookieTest = await executeScript(sessionId, `
        const testName = 'ddg_test_cookie';
        const testValue = Date.now().toString();
        
        // Try to set a cookie
        document.cookie = testName + '=' + testValue + '; path=/; max-age=3600';
        
        // Read it back
        const cookies = document.cookie.split(';');
        const found = cookies.find(c => c.trim().startsWith(testName + '='));
        
        return {
            set: !!found,
            value: found ? found.split('=')[1] : null,
            expected: testValue
        };
    `);
    
    if (cookieTest.set) {
        console.log(`   ✓ First-party cookies CAN be set`);
    } else {
        console.log(`   ❌ First-party cookies CANNOT be set - this might be the issue`);
    }
    
    // 8. Summary and hypothesis
    console.log('\n' + '='.repeat(60));
    console.log('📊 INVESTIGATION SUMMARY');
    console.log('='.repeat(60));
    
    console.log('\nHypothesis: The Nintendo region modal persists because:');
    
    if (cookies.length === 0) {
        console.log('  1. ❌ ALL cookies appear blocked - including first-party');
    } else if (!cookieTest.set) {
        console.log('  1. ❌ First-party cookies cannot be set dynamically');
    } else {
        console.log('  1. ✓ First-party cookies can be set');
    }
    
    if (storageInfo.accessible && storageInfo.count === 0) {
        console.log('  2. ⚠️ localStorage is empty - may be blocked or cleared');
    } else if (!storageInfo.accessible) {
        console.log('  2. ❌ localStorage is inaccessible');
    } else {
        console.log('  2. ✓ localStorage is accessible');
    }
    
    console.log('\n💡 Likely Root Cause:');
    console.log('   DuckDuckGo tracking protection is blocking the cookie or');
    console.log('   localStorage write that Nintendo uses to remember the');
    console.log('   user\'s region choice. Each page navigation causes the');
    console.log('   preference to be lost, triggering the modal again.');
    
    console.log('\n🔧 Potential Fixes:');
    console.log('   1. Add nintendo.com to a tracking protection allowlist');
    console.log('   2. Check if a specific cookie domain is being blocked');
    console.log('   3. Investigate if the "Stay here" button relies on');
    console.log('      third-party cookies (e.g., ec.nintendo.com)');
    
    console.log('\n✅ Session kept open for further investigation');
    console.log('   Use debug-page.mjs for more exploration');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
