#!/usr/bin/env node
/**
 * Chrome Debug Page Inspector
 * 
 * Runs the same debug inspections as debug-page.mjs but in headless Chrome.
 * Useful for comparing page state between Chrome (no protection) and DDG.
 * 
 * Usage:
 *   node scripts/chrome-debug-page.mjs <url>              # Inspect page
 *   node scripts/chrome-debug-page.mjs <url> --links      # Show link analysis
 *   node scripts/chrome-debug-page.mjs <url> --inputs     # Show form inputs
 *   node scripts/chrome-debug-page.mjs <url> --modals     # Detect modals
 *   node scripts/chrome-debug-page.mjs <url> --errors     # Show resource errors
 *   node scripts/chrome-debug-page.mjs <url> --all        # Run all inspections
 *   node scripts/chrome-debug-page.mjs <url> --json       # Output as JSON
 */

import { createRequire } from 'node:module';
import { debugScripts } from './debug-utils.mjs';

const localRequire = createRequire(import.meta.url);
/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');
const chrome = localRequire('selenium-webdriver/chrome');

// Parse args
const args = process.argv.slice(2);
const url = args.find(arg => !arg.startsWith('--')) || 'https://duckduckgo.com';
const showLinks = args.includes('--links');
const showInputs = args.includes('--inputs');
const showModals = args.includes('--modals');
const showErrors = args.includes('--errors');
const showAll = args.includes('--all');
const outputJson = args.includes('--json');
const headless = !args.includes('--no-headless');

const results = {
    browser: 'chrome',
    url,
    timestamp: new Date().toISOString(),
    pageState: null,
    elements: null,
    links: null,
    inputs: null,
    modals: null,
    errors: null
};

async function main() {
    if (!outputJson) {
        console.log('🔍 Chrome Debug Inspector');
        console.log(`   URL: ${url}`);
        console.log(`   Mode: ${headless ? 'headless' : 'visible'}\n`);
    }

    const options = new chrome.Options();
    if (headless) {
        options.addArguments('--headless=new');
    }
    options.addArguments('--window-size=1280,1024');
    options.addArguments('--disable-gpu');
    options.addArguments('--no-sandbox');

    const driver = await new selenium.Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .build();

    try {
        await driver.get(url);
        await driver.sleep(2000); // Allow page to settle

        // Get page state
        const pageState = await driver.executeScript(`return (function() { ${debugScripts.pageState} })()`);
        results.pageState = pageState;

        if (!outputJson) {
            console.log('📄 Page State:');
            console.log(`   URL: ${pageState.url}`);
            console.log(`   Title: ${pageState.title}`);
            console.log(`   Ready: ${pageState.readyState}`);
            console.log(`   Viewport: ${pageState.viewport.width}x${pageState.viewport.height}`);
        }

        // Actionable elements (default)
        if (!showLinks && !showInputs && !showModals || showAll) {
            const elements = await driver.executeScript(`return (function() { ${debugScripts.actionableElements} })()`);
            results.elements = elements;

            if (!outputJson) {
                const links = elements.filter(e => e.tag === 'a');
                const buttons = elements.filter(e => e.tag !== 'a');

                console.log('\n🎯 Actionable Elements:');
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
        }

        // Link analysis
        if (showLinks || showAll) {
            const analysis = await driver.executeScript(`return (function() { ${debugScripts.linkAnalysis} })()`);
            results.links = analysis;

            if (!outputJson) {
                console.log('\n🔗 Link Analysis:');
                console.log(`   Navigation: ${analysis.navigation.length}`);
                console.log(`   JS-triggered: ${analysis.jsTriggered.length}`);
                console.log(`   External: ${analysis.external.length}`);

                if (analysis.jsTriggered.length > 0) {
                    console.log('\n   ⚠️ JS-triggered links:');
                    analysis.jsTriggered.slice(0, 10).forEach(l => {
                        console.log(`     "${l.text}"`);
                    });
                }
            }
        }

        // Form inputs
        if (showInputs || showAll) {
            const inputs = await driver.executeScript(`return (function() { ${debugScripts.formInputs} })()`);
            results.inputs = inputs;

            if (!outputJson) {
                console.log('\n📝 Form Inputs:');
                if (inputs.length === 0) {
                    console.log('   No visible inputs found');
                } else {
                    inputs.forEach(i => {
                        const status = i.disabled ? '🔒' : i.required ? '*' : ' ';
                        console.log(`   ${status} [${i.selector}] type=${i.type} ${i.placeholder ? `"${i.placeholder}"` : ''}`);
                    });
                }
            }
        }

        // Modal detection
        if (showModals || showAll) {
            const modalInfo = await driver.executeScript(`return (function() { ${debugScripts.detectModals} })()`);
            results.modals = modalInfo;

            if (!outputJson) {
                console.log('\n🪟 Modal Detection:');
                if (!modalInfo.hasModal) {
                    console.log('   No modals detected');
                } else {
                    console.log(`   Found ${modalInfo.modals.length} modal(s):`);
                    modalInfo.modals.forEach(m => {
                        console.log(`     [${m.selector}] "${m.text?.substring(0, 50)}"`);
                    });
                }
            }
        }

        // Resource errors
        if (showErrors || showAll) {
            const errorInfo = await driver.executeScript(`return (function() { ${debugScripts.getResourceErrors} })()`);
            results.errors = errorInfo;

            if (!outputJson) {
                console.log('\n🔴 Resource Errors:');
                if (errorInfo.errors.length === 0) {
                    console.log('   No resource errors detected');
                } else {
                    errorInfo.errors.forEach(e => {
                        console.log(`   ❌ ${e.type}: ${e.name.substring(0, 80)}`);
                    });
                }
            }
        }

        if (outputJson) {
            console.log(JSON.stringify(results, null, 2));
        } else {
            console.log('\n✅ Done');
        }

    } finally {
        await driver.quit();
    }
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
