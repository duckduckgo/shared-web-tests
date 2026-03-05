#!/usr/bin/env node
/**
 * Investigate JavaScript blocking on Nintendo.com
 * 
 * Check if JavaScript is being blocked/prevented from executing.
 */

import { createRequire } from 'node:module';
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
    console.log('🔍 JavaScript Blocking Investigation');
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
    
    // Wait for initial page load
    console.log('   Waiting for page load...');
    await new Promise(r => setTimeout(r, 5000));
    
    await takeScreenshot(sessionId, `js-investigation-1-${timestamp}.png`);
    
    // Check document state
    console.log('\n📄 Document State:');
    const docState = await executeScript(sessionId, `
        return {
            readyState: document.readyState,
            url: document.URL,
            title: document.title,
            scripts: document.querySelectorAll('script').length,
            bodyLength: document.body?.innerHTML?.length || 0,
            hasReact: !!window.__NEXT_DATA__ || !!window.React || !!document.querySelector('[data-reactroot]'),
            hasNextJs: !!window.__NEXT_DATA__,
            nextData: window.__NEXT_DATA__ ? 'present' : 'missing'
        };
    `);
    console.log(`   readyState: ${docState.readyState}`);
    console.log(`   title: ${docState.title || '(empty)'}`);
    console.log(`   body length: ${docState.bodyLength} chars`);
    console.log(`   scripts: ${docState.scripts}`);
    console.log(`   hasReact: ${docState.hasReact}`);
    console.log(`   hasNextJs: ${docState.hasNextJs}`);
    console.log(`   __NEXT_DATA__: ${docState.nextData}`);
    
    // Check for errors
    console.log('\n🔴 JavaScript Errors:');
    const errors = await executeScript(sessionId, `
        // Check for React error boundaries
        const errorBoundaries = document.querySelectorAll('[data-reactroot]');
        const results = {
            errors: [],
            warnings: []
        };
        
        // Check for common error indicators
        const errorText = document.body?.innerText || '';
        if (errorText.includes('Error') || errorText.includes('error')) {
            results.errors.push('Error text found in page');
        }
        
        // Check console override for errors
        if (window.__ddg_captured_errors) {
            results.errors = results.errors.concat(window.__ddg_captured_errors);
        }
        
        return results;
    `);
    
    if (errors.errors.length === 0) {
        console.log('   No obvious errors detected');
    } else {
        for (const err of errors.errors) {
            console.log(`   ❌ ${err}`);
        }
    }

    // Check specifically for React hydration
    console.log('\n⚛️ React/Next.js Hydration Check:');
    const reactCheck = await executeScript(sessionId, `
        const results = {
            hasNextData: !!window.__NEXT_DATA__,
            hasReactFiber: false,
            rootElements: [],
            textContentSample: ''
        };
        
        // Look for React fiber nodes
        const rootEl = document.getElementById('__next');
        if (rootEl) {
            results.rootElements.push('#__next');
            results.textContentSample = rootEl.textContent?.substring(0, 100) || '';
            
            // Check for React internal properties
            const keys = Object.keys(rootEl);
            const fiberKey = keys.find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            results.hasReactFiber = !!fiberKey;
        }
        
        // Check for any hydration errors
        const hydrationErrors = document.querySelectorAll('[data-hydration-error]');
        results.hydrationErrors = hydrationErrors.length;
        
        return results;
    `);
    console.log(`   __NEXT_DATA__: ${reactCheck.hasNextData}`);
    console.log(`   React Fiber attached: ${reactCheck.hasReactFiber}`);
    console.log(`   Root elements: ${reactCheck.rootElements.join(', ') || 'none'}`);
    console.log(`   Text content sample: "${reactCheck.textContentSample}"`);
    
    // Check network requests that might be blocked
    console.log('\n🌐 Checking for blocked resources (via Performance API):');
    const perfCheck = await executeScript(sessionId, `
        const resources = performance.getEntriesByType('resource');
        return resources.map(r => ({
            name: r.name.substring(0, 80),
            type: r.initiatorType,
            duration: Math.round(r.duration),
            transferSize: r.transferSize || 0,
            failed: r.transferSize === 0 && r.duration > 0
        })).filter(r => r.type === 'script');
    `);
    
    const failedScripts = perfCheck.filter(s => s.failed);
    console.log(`   Total scripts: ${perfCheck.length}`);
    console.log(`   Potentially blocked: ${failedScripts.length}`);
    if (failedScripts.length > 0) {
        console.log('   Blocked scripts:');
        failedScripts.slice(0, 5).forEach(s => {
            console.log(`     ❌ ${s.name}...`);
        });
    }

    // Wait longer and check again
    console.log('\n⏳ Waiting 10 seconds for late hydration...');
    await new Promise(r => setTimeout(r, 10000));
    
    await takeScreenshot(sessionId, `js-investigation-2-${timestamp}.png`);
    
    // Re-check modal
    console.log('\n🪟 Modal Check (after waiting):');
    const modalCheck = await executeScript(sessionId, `
        const dialogs = document.querySelectorAll('[role="dialog"]');
        const results = [];
        
        for (const dialog of dialogs) {
            const style = window.getComputedStyle(dialog);
            if (style.display !== 'none') {
                const buttons = Array.from(dialog.querySelectorAll('button'));
                results.push({
                    visible: true,
                    text: dialog.textContent?.trim().substring(0, 300),
                    buttons: buttons.map(b => ({
                        text: b.textContent?.trim(),
                        ariaLabel: b.getAttribute('aria-label'),
                        visible: window.getComputedStyle(b).display !== 'none'
                    })),
                    classList: dialog.className
                });
            }
        }
        
        return results;
    `);
    
    if (modalCheck.length === 0) {
        console.log('   No visible modals found');
    } else {
        for (const m of modalCheck) {
            console.log(`   Modal class: ${m.classList}`);
            console.log(`   Text (${m.text?.length || 0} chars): "${m.text?.substring(0, 100)}..."`);
            console.log(`   Buttons (${m.buttons.length}):`);
            for (const b of m.buttons) {
                console.log(`     - "${b.text || b.ariaLabel || '(empty)'}" visible: ${b.visible}`);
            }
        }
    }

    // Check if any JavaScript globals exist that indicate the app loaded
    console.log('\n🔧 JavaScript Globals Check:');
    const globalsCheck = await executeScript(sessionId, `
        return {
            jQuery: typeof jQuery !== 'undefined',
            React: typeof React !== 'undefined',
            ReactDOM: typeof ReactDOM !== 'undefined',
            next: typeof __NEXT_DATA__ !== 'undefined',
            optimizely: typeof optimizely !== 'undefined',
            dataLayer: typeof dataLayer !== 'undefined',
            DDG: typeof DDG !== 'undefined'
        };
    `);
    console.log(`   jQuery: ${globalsCheck.jQuery}`);
    console.log(`   React: ${globalsCheck.React}`);
    console.log(`   ReactDOM: ${globalsCheck.ReactDOM}`);
    console.log(`   __NEXT_DATA__: ${globalsCheck.next}`);
    console.log(`   Optimizely: ${globalsCheck.optimizely}`);
    console.log(`   dataLayer: ${globalsCheck.dataLayer}`);
    console.log(`   DDG: ${globalsCheck.DDG}`);

    // Get raw HTML to see if content is in SSR
    console.log('\n📝 Server-Side Rendered Content Check:');
    const ssrCheck = await executeScript(sessionId, `
        const nextContainer = document.getElementById('__next');
        if (!nextContainer) return { found: false };
        
        const html = nextContainer.innerHTML;
        return {
            found: true,
            length: html.length,
            hasButtons: html.includes('button') || html.includes('Button'),
            hasStayHere: html.includes('Stay here') || html.includes('stay here'),
            hasRegion: html.includes('region') || html.includes('Region'),
            sample: html.substring(0, 500)
        };
    `);
    
    if (!ssrCheck.found) {
        console.log('   ❌ #__next container not found');
    } else {
        console.log(`   Container length: ${ssrCheck.length} chars`);
        console.log(`   Has "button": ${ssrCheck.hasButtons}`);
        console.log(`   Has "Stay here": ${ssrCheck.hasStayHere}`);
        console.log(`   Has "region": ${ssrCheck.hasRegion}`);
        console.log(`   Sample: "${ssrCheck.sample?.substring(0, 200)}..."`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    
    if (!reactCheck.hasReactFiber && reactCheck.hasNextData) {
        console.log('\n❌ React is NOT hydrating:');
        console.log('   - __NEXT_DATA__ is present (SSR worked)');
        console.log('   - React Fiber is NOT attached (client JS failed)');
        console.log('   - This indicates JavaScript is being blocked');
    } else if (reactCheck.hasReactFiber) {
        console.log('\n✓ React appears to be hydrated');
    }
    
    if (modalCheck.length > 0 && modalCheck[0].text?.length === 0) {
        console.log('\n⚠️ Modal exists but has empty content:');
        console.log('   - Modal HTML structure present');
        console.log('   - Text content not rendered');
        console.log('   - React components not mounting properly');
    }

    console.log('\n✅ Session kept open for manual inspection');
    console.log('   Browser should be visible in the Simulator');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
