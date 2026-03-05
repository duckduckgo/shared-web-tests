#!/usr/bin/env node
/**
 * Debug Page Inspector
 * 
 * Connects to an existing WebDriver session and inspects the current page.
 * Useful for debugging when tests fail or clicks don't work.
 * 
 * Usage:
 *   node scripts/debug-page.mjs                    # Inspect current page
 *   node scripts/debug-page.mjs --links            # Show link analysis
 *   node scripts/debug-page.mjs --inputs           # Show form inputs
 *   node scripts/debug-page.mjs --modals           # Detect modals
 *   node scripts/debug-page.mjs --console          # Show captured console logs
 *   node scripts/debug-page.mjs --console-start    # Start console capture
 *   node scripts/debug-page.mjs --console-stop     # Stop capture and show logs
 *   node scripts/debug-page.mjs --errors           # Show resource load errors
 *   node scripts/debug-page.mjs --find "download"  # Find elements with text
 *   node scripts/debug-page.mjs --click "selector" # Debug a click
 *   node scripts/debug-page.mjs --all              # Run all inspections
 * 
 * Environment:
 *   WEBDRIVER_SERVER_URL: WebDriver server URL (default: http://localhost:4444)
 */

import { createRequire } from 'node:module';
import { debugScripts, runDebug, logActionableElements, logLinkAnalysis } from './debug-utils.mjs';

const localRequire = createRequire(import.meta.url);
/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

// Parse args
const args = process.argv.slice(2);
const showLinks = args.includes('--links');
const showInputs = args.includes('--inputs');
const showModals = args.includes('--modals');
const showConsole = args.includes('--console');
const startConsole = args.includes('--console-start');
const stopConsole = args.includes('--console-stop');
const showErrors = args.includes('--errors');
const showAll = args.includes('--all');
const findText = args.includes('--find') ? args[args.indexOf('--find') + 1] : null;
const clickSelector = args.includes('--click') ? args[args.indexOf('--click') + 1] : null;

async function getExistingSession() {
    try {
        const response = await fetch(`${serverUrl}/sessions`);
        if (response.ok) {
            const data = await response.json();
            const sessions = data.value || (Array.isArray(data) ? data : []);
            if (sessions.length > 0) {
                return sessions[0].id || sessions[0].sessionId || sessions[0];
            }
        }
    } catch {
        // Server not running
    }
    return null;
}

async function main() {
    console.log('🔍 Page Debug Inspector');
    console.log(`   Server: ${serverUrl}\n`);

    // Find existing session
    const sessionId = await getExistingSession();
    if (!sessionId) {
        console.error('❌ No active WebDriver session found.');
        console.error('   Start a test script first, or run with --keep flag.');
        process.exit(1);
    }

    console.log(`   Session: ${sessionId}\n`);

    // Connect to existing session using the WebDriver HTTP API directly
    // since selenium-webdriver doesn't support attaching to existing sessions easily
    
    async function executeScript(script, ...args) {
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

    // Get page state
    const pageState = await executeScript(debugScripts.pageState);
    console.log('📄 Page State:');
    console.log(`   URL: ${pageState.url}`);
    console.log(`   Title: ${pageState.title}`);
    console.log(`   Ready: ${pageState.readyState}`);
    console.log(`   Viewport: ${pageState.viewport.width}x${pageState.viewport.height}`);

    // Show actionable elements (default)
    if (!showLinks && !showInputs && !showModals && !findText && !clickSelector || showAll) {
        console.log('\n🎯 Actionable Elements:');
        const elements = await executeScript(debugScripts.actionableElements);
        
        const links = elements.filter(e => e.tag === 'a');
        const buttons = elements.filter(e => e.tag !== 'a');
        
        if (buttons.length > 0) {
            console.log(`\n   Buttons (${buttons.length}):`);
            buttons.slice(0, 15).forEach(e => {
                const status = e.disabled ? '🔒' : '✓';
                console.log(`     ${status} [${e.selector}] "${e.text}"`);
            });
            if (buttons.length > 15) console.log(`     ... and ${buttons.length - 15} more`);
        }
        
        if (links.length > 0) {
            console.log(`\n   Links (${links.length}):`);
            links.slice(0, 15).forEach(e => {
                const icon = e.hrefType === 'hash-only' ? '⚠️' :
                            e.hrefType === 'javascript' ? '⚠️' : '→';
                console.log(`     ${icon} [${e.selector}] "${e.text}" ${e.href?.substring(0, 40) || ''}`);
            });
            if (links.length > 15) console.log(`     ... and ${links.length - 15} more`);
        }
    }

    // Link analysis
    if (showLinks || showAll) {
        console.log('\n🔗 Link Analysis:');
        const analysis = await executeScript(debugScripts.linkAnalysis);
        
        console.log(`   Navigation: ${analysis.navigation.length}`);
        console.log(`   JS-triggered: ${analysis.jsTriggered.length}`);
        console.log(`   External: ${analysis.external.length}`);
        
        if (analysis.jsTriggered.length > 0) {
            console.log('\n   ⚠️ JS-triggered (href="#" or javascript:) - may need special handling:');
            analysis.jsTriggered.slice(0, 10).forEach(l => {
                console.log(`     "${l.text}"`);
            });
        }
    }

    // Form inputs
    if (showInputs || showAll) {
        console.log('\n📝 Form Inputs:');
        const inputs = await executeScript(debugScripts.formInputs);
        
        if (inputs.length === 0) {
            console.log('   No visible inputs found');
        } else {
            inputs.forEach(i => {
                const status = i.disabled ? '🔒' : i.required ? '*' : ' ';
                console.log(`   ${status} [${i.selector}] type=${i.type} ${i.placeholder ? `"${i.placeholder}"` : ''}`);
            });
        }
    }

    // Modal detection
    if (showModals || showAll) {
        console.log('\n🪟 Modal Detection:');
        const modalInfo = await executeScript(debugScripts.detectModals);
        
        if (!modalInfo.hasModal) {
            console.log('   No modals detected');
        } else {
            console.log(`   Found ${modalInfo.modals.length} modal(s):`);
            modalInfo.modals.forEach(m => {
                console.log(`     [${m.selector}] "${m.text?.substring(0, 50)}"`);
                if (m.hasCloseButton) console.log('       Has close button');
            });
        }
    }

    // Find by text
    if (findText) {
        console.log(`\n🔎 Elements containing "${findText}":`);
        const found = await executeScript(debugScripts.findByText, findText, false);
        
        if (found.length === 0) {
            console.log('   No matching elements found');
        } else {
            found.forEach(e => {
                console.log(`   <${e.tag}> [${e.selector}] "${e.text?.substring(0, 50)}"`);
                if (e.href) console.log(`     href: ${e.href}`);
            });
        }
    }

    // Console capture - start
    if (startConsole) {
        console.log('\n📋 Starting Console Capture...');
        const result = await executeScript(debugScripts.startConsoleCapture);
        console.log(`   Status: ${result.status}`);
        if (result.cleared) console.log('   (Previous logs cleared)');
        console.log('   Run with --console or --console-stop to view logs');
    }

    // Console capture - show logs
    if (showConsole || stopConsole || showAll) {
        console.log('\n📋 Console Logs:');
        const result = await executeScript(debugScripts.getConsoleLogs, stopConsole);
        
        if (result.error) {
            console.log(`   ⚠️ ${result.error}`);
            console.log('   Run with --console-start first to begin capturing');
        } else if (result.logs.length === 0) {
            console.log('   (no logs captured)');
        } else {
            const levelIcons = {
                log: '  ',
                info: 'ℹ️',
                warn: '⚠️',
                error: '❌',
                debug: '🔍',
                exception: '💥',
                rejection: '💔'
            };
            
            result.logs.slice(-30).forEach(entry => {
                const icon = levelIcons[entry.level] || '  ';
                const msg = entry.message.substring(0, 150);
                console.log(`   ${icon} [${entry.level}] ${msg}`);
            });
            
            if (result.logs.length > 30) {
                console.log(`   ... and ${result.logs.length - 30} more`);
            }
            
            if (stopConsole) {
                console.log('\n   ✓ Console capture stopped');
            }
        }
    }

    // Resource errors
    if (showErrors || showAll) {
        console.log('\n🔴 Resource Errors:');
        const result = await executeScript(debugScripts.getResourceErrors);
        
        if (result.errors.length === 0) {
            console.log('   No resource errors detected');
        } else {
            result.errors.forEach(e => {
                console.log(`   ❌ ${e.type}: ${e.name.substring(0, 80)}`);
            });
        }
    }

    // Debug click
    if (clickSelector) {
        console.log(`\n🖱️ Debug Click: ${clickSelector}`);
        
        // Start DOM tracking
        await executeScript(debugScripts.domTracker, 'start');
        
        // Execute click
        const clickResult = await executeScript(debugScripts.debugClick, clickSelector);
        
        // Wait for effects
        await new Promise(r => setTimeout(r, 500));
        
        // Get DOM changes
        const domChanges = await executeScript(debugScripts.domTracker, 'stop');
        
        if (clickResult.error) {
            console.log(`   ❌ ${clickResult.error}`);
        } else {
            console.log(`   Element: <${clickResult.element.tag}> "${clickResult.element.text}"`);
            console.log(`   Events: ${clickResult.events.map(e => e.type).join(', ') || 'none'}`);
            console.log(`   URL changed: ${clickResult.urlChanged}`);
            if (clickResult.urlChanged) {
                console.log(`   New URL: ${clickResult.newUrl}`);
            }
            
            if (domChanges.added?.length > 0) {
                console.log(`\n   DOM Added (${domChanges.added.length}):`);
                domChanges.added.slice(0, 5).forEach(e => {
                    console.log(`     + <${e.tag}> ${e.text?.substring(0, 40)}`);
                });
            }
            
            if (domChanges.attributes?.length > 0) {
                console.log(`\n   Attributes Changed (${domChanges.attributes.length}):`);
                domChanges.attributes.slice(0, 5).forEach(e => {
                    console.log(`     ~ <${e.tag}> ${e.attr}=${e.newValue?.substring(0, 30)}`);
                });
            }
        }
    }

    console.log('\n✅ Done');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
