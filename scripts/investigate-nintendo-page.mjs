#!/usr/bin/env node
/**
 * Investigate Nintendo page state and try adding a product
 */

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

async function executeScript(sessionId, script) {
    const response = await fetch(`${serverUrl}/session/${sessionId}/execute/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            script: `return (function() { ${script} })()`,
            args: []
        })
    });
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
    console.log('🔍 Investigating Nintendo Page State\n');

    const sessionId = await createSession();
    if (!sessionId) {
        console.error('Failed to create session');
        process.exit(1);
    }
    console.log(`Session: ${sessionId}\n`);

    // Navigate to a product page directly
    const productUrl = 'https://www.nintendo.com/us/store/products/the-legend-of-zelda-tears-of-the-kingdom-switch/';
    console.log(`📍 Navigating to product page: ${productUrl}`);
    await navigateTo(sessionId, productUrl);
    
    console.log('   Waiting 10s for page load...');
    await new Promise(r => setTimeout(r, 10000));

    // Check page state
    console.log('\n📋 Page State:');
    const pageState = await executeScript(sessionId, `
        return {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            bodyLength: document.body?.innerHTML?.length || 0
        };
    `);
    console.log(`   URL: ${pageState.url}`);
    console.log(`   Title: ${pageState.title}`);
    console.log(`   Ready State: ${pageState.readyState}`);
    console.log(`   Body Length: ${pageState.bodyLength}`);

    // Check for modals
    console.log('\n🔍 Checking for modals:');
    const modals = await executeScript(sessionId, `
        const dialogs = document.querySelectorAll('[role="dialog"]');
        return Array.from(dialogs).map(d => {
            const style = window.getComputedStyle(d);
            return {
                className: d.className,
                visible: style.display !== 'none' && style.visibility !== 'hidden',
                ariaHidden: d.getAttribute('aria-hidden'),
                hasInert: d.hasAttribute('inert'),
                contentLength: d.textContent?.length || 0,
                innerHTML: d.innerHTML.substring(0, 300)
            };
        });
    `);
    
    for (let i = 0; i < modals.length; i++) {
        const m = modals[i];
        console.log(`   Modal ${i + 1}: class="${m.className}"`);
        console.log(`      visible=${m.visible}, aria-hidden=${m.ariaHidden}, inert=${m.hasInert}`);
        console.log(`      content length=${m.contentLength}`);
        if (m.visible) {
            console.log(`      innerHTML: ${m.innerHTML}`);
        }
    }

    // Check for "Add to Cart" button
    console.log('\n🛒 Looking for Add to Cart button:');
    const addToCart = await executeScript(sessionId, `
        // Try multiple selectors
        const selectors = [
            'button[data-testid*="add"]',
            'button[aria-label*="Add to Cart"]',
            'button[aria-label*="add to cart"]',
            '[class*="AddToCart"]',
            '[class*="add-to-cart"]',
            'button:has-text("Add to Cart")'
        ];
        
        // Also search by text content
        const buttons = document.querySelectorAll('button');
        const addButtons = [];
        
        for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase();
            if (text.includes('add to cart') || text.includes('add to bag')) {
                const rect = btn.getBoundingClientRect();
                const style = window.getComputedStyle(btn);
                addButtons.push({
                    text: btn.textContent?.trim(),
                    className: btn.className,
                    disabled: btn.disabled,
                    visible: rect.width > 0 && rect.height > 0 && style.display !== 'none',
                    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
                });
            }
        }
        
        return { addButtons, totalButtons: buttons.length };
    `);
    
    console.log(`   Total buttons on page: ${addToCart.totalButtons}`);
    console.log(`   Add to Cart buttons found: ${addToCart.addButtons.length}`);
    for (const btn of addToCart.addButtons) {
        console.log(`      - "${btn.text}" (visible=${btn.visible}, disabled=${btn.disabled})`);
        console.log(`        rect: ${JSON.stringify(btn.rect)}`);
    }

    // Check page content
    console.log('\n📄 Page Content Sample:');
    const content = await executeScript(sessionId, `
        const bodyText = document.body?.innerText || '';
        const productName = document.querySelector('h1')?.textContent;
        const price = document.querySelector('[class*="price"], [class*="Price"]')?.textContent;
        
        return {
            productName,
            price,
            bodyTextSample: bodyText.substring(0, 500),
            hasStayHere: bodyText.includes('Stay here'),
            hasSelectRegion: bodyText.includes('Select your region') || bodyText.includes('region'),
            hasAddToCart: bodyText.toLowerCase().includes('add to cart')
        };
    `);
    
    console.log(`   Product Name: ${content.productName || '(not found)'}`);
    console.log(`   Price: ${content.price || '(not found)'}`);
    console.log(`   Has "Stay here": ${content.hasStayHere}`);
    console.log(`   Has "Select region": ${content.hasSelectRegion}`);
    console.log(`   Has "Add to Cart": ${content.hasAddToCart}`);
    console.log(`\n   Body text sample:\n   ${content.bodyTextSample?.substring(0, 300)}`);

    // Try clicking the visible modal's close button if there is one
    console.log('\n🖱️ Attempting to close visible modal:');
    const closeResult = await executeScript(sessionId, `
        const visibleModal = document.querySelector('.blG--[role="dialog"]');
        if (!visibleModal) {
            // Try other visible modals
            const dialogs = document.querySelectorAll('[role="dialog"]');
            for (const d of dialogs) {
                const style = window.getComputedStyle(d);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                    const closeBtn = d.querySelector('button[data-modalclosebutton], button[aria-label="Close"]');
                    if (closeBtn) {
                        closeBtn.click();
                        return { clicked: true, modalClass: d.className };
                    }
                }
            }
            return { clicked: false, reason: 'No visible modal with close button' };
        }
        
        const closeBtn = visibleModal.querySelector('button[data-modalclosebutton="true"]');
        if (closeBtn) {
            closeBtn.click();
            return { clicked: true, modalClass: 'blG--' };
        }
        return { clicked: false, reason: 'Close button not found' };
    `);
    
    console.log(`   Result: ${JSON.stringify(closeResult)}`);

    // Wait and check again
    await new Promise(r => setTimeout(r, 2000));

    const afterClose = await executeScript(sessionId, `
        const dialogs = document.querySelectorAll('[role="dialog"]');
        const visible = Array.from(dialogs).filter(d => {
            const style = window.getComputedStyle(d);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });
        return {
            totalDialogs: dialogs.length,
            visibleDialogs: visible.length,
            visibleClasses: visible.map(d => d.className)
        };
    `);
    
    console.log(`   After close: ${afterClose.visibleDialogs} visible dialogs remaining`);

    // Check React/Next.js state
    console.log('\n⚛️ React/Next.js State:');
    const reactState = await executeScript(sessionId, `
        return {
            hasNextData: !!window.__NEXT_DATA__,
            hasReact: !!window.React,
            hasReactDOM: !!window.ReactDOM,
            nextDataKeys: window.__NEXT_DATA__ ? Object.keys(window.__NEXT_DATA__) : [],
            // Check if React has hydrated
            hasReactRoot: !!document.querySelector('[data-reactroot]') || !!document.querySelector('#__next'),
            reactRootHasChildren: document.querySelector('#__next')?.children?.length || 0
        };
    `);
    
    console.log(`   __NEXT_DATA__: ${reactState.hasNextData}`);
    console.log(`   window.React: ${reactState.hasReact}`);
    console.log(`   window.ReactDOM: ${reactState.hasReactDOM}`);
    console.log(`   #__next children: ${reactState.reactRootHasChildren}`);

    console.log('\n✅ Investigation complete');
    console.log('   Session kept open for manual inspection');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
