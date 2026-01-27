/**
 * WebDriver Debugging Utilities
 * 
 * Provides injectable scripts for debugging page interactions.
 * Import and use with driver.executeScript().
 * 
 * Usage:
 *   import { debugScripts, runDebug } from './debug-utils.mjs';
 *   const elements = await runDebug(driver, 'actionableElements');
 */

/**
 * Injectable debug scripts - raw JS strings for executeScript()
 */
export const debugScripts = {
    /**
     * Get all actionable elements (buttons, links) with their properties
     * Returns: Array of { tag, text, href, type, hasClickHandler, selector, rect }
     */
    actionableElements: `
        const results = [];
        const seen = new WeakSet();
        
        function getSelector(el) {
            if (el.id) return '#' + el.id;
            if (el.className && typeof el.className === 'string') {
                const classes = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
                if (classes) return el.tagName.toLowerCase() + '.' + classes;
            }
            return el.tagName.toLowerCase();
        }
        
        function hasClickHandler(el) {
            // Check for onclick attribute
            if (el.onclick || el.getAttribute('onclick')) return true;
            // Check for common event listener patterns
            if (el._events || el.__events || el.__zone_symbol__clickfalse) return true;
            // Check React/Vue patterns
            if (el.__reactFiber$ || el.__vue__) return true;
            return false;
        }
        
        // Links
        document.querySelectorAll('a[href]').forEach(el => {
            if (seen.has(el)) return;
            seen.add(el);
            const href = el.getAttribute('href') || '';
            const text = (el.textContent || '').trim().substring(0, 60);
            if (!text && !href) return;
            
            results.push({
                tag: 'a',
                text,
                href,
                hrefType: href === '#' ? 'hash-only' : 
                          href.startsWith('javascript:') ? 'javascript' :
                          href.startsWith('http') ? 'absolute' :
                          href.startsWith('/') ? 'relative' : 'other',
                hasClickHandler: hasClickHandler(el),
                selector: getSelector(el),
                visible: el.offsetParent !== null,
                rect: el.getBoundingClientRect().toJSON()
            });
        });
        
        // Buttons
        document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(el => {
            if (seen.has(el)) return;
            seen.add(el);
            const text = (el.textContent || el.value || '').trim().substring(0, 60);
            
            results.push({
                tag: el.tagName.toLowerCase(),
                text,
                href: null,
                hrefType: null,
                type: el.type || el.getAttribute('role'),
                hasClickHandler: hasClickHandler(el),
                selector: getSelector(el),
                disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
                visible: el.offsetParent !== null,
                rect: el.getBoundingClientRect().toJSON()
            });
        });
        
        // Clickable divs/spans (role=button or tabindex with click styling)
        document.querySelectorAll('[tabindex="0"], [onclick]').forEach(el => {
            if (seen.has(el) || el.tagName === 'A' || el.tagName === 'BUTTON') return;
            seen.add(el);
            const text = (el.textContent || '').trim().substring(0, 60);
            if (!text) return;
            
            results.push({
                tag: el.tagName.toLowerCase(),
                text,
                href: null,
                hrefType: null,
                hasClickHandler: true,
                selector: getSelector(el),
                visible: el.offsetParent !== null,
                rect: el.getBoundingClientRect().toJSON()
            });
        });
        
        return results.filter(r => r.visible);
    `,

    /**
     * Find elements matching a text pattern
     * Args: [searchText: string, caseSensitive?: boolean]
     * Returns: Array of { tag, text, selector, href }
     */
    findByText: `
        const [searchText, caseSensitive = false] = arguments;
        const pattern = caseSensitive ? searchText : searchText.toLowerCase();
        const results = [];
        
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_ELEMENT,
            null
        );
        
        let node;
        while (node = walker.nextNode()) {
            const text = (node.textContent || '').trim();
            const matchText = caseSensitive ? text : text.toLowerCase();
            
            if (matchText.includes(pattern)) {
                // Only include if this element is the most specific container
                const childWithText = Array.from(node.children).some(child => {
                    const childText = caseSensitive ? child.textContent : (child.textContent || '').toLowerCase();
                    return childText.includes(pattern);
                });
                
                if (!childWithText || node.children.length === 0) {
                    results.push({
                        tag: node.tagName.toLowerCase(),
                        text: text.substring(0, 100),
                        selector: node.id ? '#' + node.id : 
                                  node.className ? node.tagName.toLowerCase() + '.' + (node.className.split(' ')[0]) :
                                  node.tagName.toLowerCase(),
                        href: node.getAttribute('href'),
                        visible: node.offsetParent !== null
                    });
                }
            }
        }
        
        return results.filter(r => r.visible).slice(0, 20);
    `,

    /**
     * Get all links grouped by type (navigation vs JS-triggered)
     * Returns: { navigation: [...], jsTriggered: [...], other: [...] }
     */
    linkAnalysis: `
        const links = Array.from(document.querySelectorAll('a[href]'));
        const result = {
            navigation: [],
            jsTriggered: [],
            external: [],
            other: []
        };
        
        links.forEach(link => {
            const href = link.getAttribute('href') || '';
            const text = (link.textContent || '').trim().substring(0, 50);
            if (!text && !link.querySelector('img, svg')) return;
            if (link.offsetParent === null) return; // Not visible
            
            const entry = { text: text || '[icon]', href };
            
            if (href === '#' || href.startsWith('javascript:') || href === '') {
                result.jsTriggered.push(entry);
            } else if (href.startsWith('http') && !href.includes(location.hostname)) {
                result.external.push(entry);
            } else if (href.startsWith('/') || href.startsWith('http')) {
                result.navigation.push(entry);
            } else {
                result.other.push(entry);
            }
        });
        
        return result;
    `,

    /**
     * Track DOM changes after an action (call before, then after action)
     * Mode: 'start' to begin tracking, 'stop' to get results
     * Returns on stop: { added: [...], removed: [...], changed: [...] }
     */
    domTracker: `
        const mode = arguments[0];
        
        if (mode === 'start') {
            window.__domTracker = {
                changes: [],
                observer: new MutationObserver(mutations => {
                    mutations.forEach(m => {
                        if (m.type === 'childList') {
                            m.addedNodes.forEach(n => {
                                if (n.nodeType === 1) {
                                    window.__domTracker.changes.push({
                                        type: 'added',
                                        tag: n.tagName,
                                        text: (n.textContent || '').substring(0, 50),
                                        id: n.id,
                                        classes: n.className
                                    });
                                }
                            });
                            m.removedNodes.forEach(n => {
                                if (n.nodeType === 1) {
                                    window.__domTracker.changes.push({
                                        type: 'removed',
                                        tag: n.tagName,
                                        text: (n.textContent || '').substring(0, 50)
                                    });
                                }
                            });
                        } else if (m.type === 'attributes') {
                            window.__domTracker.changes.push({
                                type: 'attribute',
                                tag: m.target.tagName,
                                attr: m.attributeName,
                                newValue: m.target.getAttribute(m.attributeName)
                            });
                        }
                    });
                })
            };
            window.__domTracker.observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled']
            });
            return { status: 'tracking' };
        }
        
        if (mode === 'stop') {
            if (!window.__domTracker) return { error: 'Tracker not started' };
            window.__domTracker.observer.disconnect();
            const changes = window.__domTracker.changes;
            delete window.__domTracker;
            return {
                added: changes.filter(c => c.type === 'added'),
                removed: changes.filter(c => c.type === 'removed'),
                attributes: changes.filter(c => c.type === 'attribute')
            };
        }
        
        return { error: 'Invalid mode. Use "start" or "stop"' };
    `,

    /**
     * Debug a click - reports if handlers fired
     * Args: [selector: string] - CSS selector of element to click
     * Returns: { clicked: boolean, handlers: [...], urlChanged: boolean, newUrl: string }
     */
    debugClick: `
        const selector = arguments[0];
        const el = document.querySelector(selector);
        if (!el) return { error: 'Element not found: ' + selector };
        
        const result = {
            element: {
                tag: el.tagName,
                text: (el.textContent || '').trim().substring(0, 50),
                href: el.getAttribute('href')
            },
            originalUrl: location.href,
            handlers: [],
            events: []
        };
        
        // Intercept and log events
        const eventTypes = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];
        const originalListeners = {};
        
        eventTypes.forEach(type => {
            const handler = (e) => {
                result.events.push({
                    type,
                    target: e.target.tagName,
                    defaultPrevented: e.defaultPrevented,
                    propagationStopped: e.cancelBubble
                });
            };
            el.addEventListener(type, handler, true);
            originalListeners[type] = handler;
        });
        
        // Dispatch a real click
        el.click();
        
        // Clean up listeners
        eventTypes.forEach(type => {
            el.removeEventListener(type, originalListeners[type], true);
        });
        
        // Check if URL changed
        result.urlChanged = location.href !== result.originalUrl;
        result.newUrl = location.href;
        
        return result;
    `,

    /**
     * Get form inputs on the page
     * Returns: Array of { name, type, id, placeholder, value, selector }
     */
    formInputs: `
        const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
        return inputs
            .filter(el => el.offsetParent !== null) // visible only
            .map(el => ({
                tag: el.tagName.toLowerCase(),
                type: el.type,
                name: el.name,
                id: el.id,
                placeholder: el.placeholder,
                value: el.type === 'password' ? '[hidden]' : (el.value || '').substring(0, 30),
                selector: el.id ? '#' + el.id : 
                          el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' :
                          el.tagName.toLowerCase() + '[type="' + el.type + '"]',
                required: el.required,
                disabled: el.disabled
            }));
    `,

    /**
     * Check if page has any modals/dialogs open
     * Returns: { hasModal: boolean, modals: [...] }
     */
    detectModals: `
        const modalSelectors = [
            '[role="dialog"]',
            '[role="alertdialog"]',
            '[aria-modal="true"]',
            '.modal:not([hidden])',
            '.Modal:not([hidden])',
            '[class*="modal"]:not([hidden])',
            '[class*="Modal"]:not([hidden])',
            '[class*="dialog"]:not([hidden])',
            '[class*="Dialog"]:not([hidden])',
            '[class*="popup"]:not([hidden])',
            '[class*="Popup"]:not([hidden])',
            '[class*="overlay"]:not([hidden])'
        ];
        
        const modals = [];
        const seen = new WeakSet();
        
        modalSelectors.forEach(sel => {
            try {
                document.querySelectorAll(sel).forEach(el => {
                    if (seen.has(el) || el.offsetParent === null) return;
                    // Check if actually visible
                    const style = getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden') return;
                    
                    seen.add(el);
                    modals.push({
                        selector: sel,
                        text: (el.textContent || '').trim().substring(0, 100),
                        hasCloseButton: !!el.querySelector('[aria-label*="close"], [aria-label*="Close"], button:has(svg), .close'),
                        rect: el.getBoundingClientRect().toJSON()
                    });
                });
            } catch {}
        });
        
        return {
            hasModal: modals.length > 0,
            modals
        };
    `,

    /**
     * Start capturing console logs
     * Call before actions you want to monitor, then use 'getConsoleLogs' to retrieve
     * Returns: { status: 'capturing' }
     */
    startConsoleCapture: `
        if (window.__consoleCapture) {
            // Already capturing, just clear
            window.__consoleCapture.logs = [];
            return { status: 'already_capturing', cleared: true };
        }
        
        window.__consoleCapture = {
            logs: [],
            original: {
                log: console.log,
                warn: console.warn,
                error: console.error,
                info: console.info,
                debug: console.debug
            }
        };
        
        ['log', 'warn', 'error', 'info', 'debug'].forEach(level => {
            console[level] = function(...args) {
                window.__consoleCapture.logs.push({
                    level,
                    timestamp: Date.now(),
                    message: args.map(a => {
                        try {
                            if (typeof a === 'object') return JSON.stringify(a);
                            return String(a);
                        } catch { return '[Object]'; }
                    }).join(' ')
                });
                window.__consoleCapture.original[level].apply(console, args);
            };
        });
        
        // Also capture unhandled errors
        window.__consoleCapture.errorHandler = (event) => {
            window.__consoleCapture.logs.push({
                level: 'exception',
                timestamp: Date.now(),
                message: event.message + ' at ' + event.filename + ':' + event.lineno
            });
        };
        window.addEventListener('error', window.__consoleCapture.errorHandler);
        
        // Capture unhandled promise rejections
        window.__consoleCapture.rejectionHandler = (event) => {
            window.__consoleCapture.logs.push({
                level: 'rejection',
                timestamp: Date.now(),
                message: String(event.reason)
            });
        };
        window.addEventListener('unhandledrejection', window.__consoleCapture.rejectionHandler);
        
        return { status: 'capturing' };
    `,

    /**
     * Get captured console logs and optionally stop capturing
     * Args: [stopCapture?: boolean] - if true, restores original console
     * Returns: { logs: [...], count: number }
     */
    getConsoleLogs: `
        const stopCapture = arguments[0] ?? false;
        
        if (!window.__consoleCapture) {
            return { logs: [], count: 0, error: 'Capture not started' };
        }
        
        const logs = [...window.__consoleCapture.logs];
        
        if (stopCapture) {
            // Restore original console methods
            Object.keys(window.__consoleCapture.original).forEach(level => {
                console[level] = window.__consoleCapture.original[level];
            });
            window.removeEventListener('error', window.__consoleCapture.errorHandler);
            window.removeEventListener('unhandledrejection', window.__consoleCapture.rejectionHandler);
            delete window.__consoleCapture;
        }
        
        return { logs, count: logs.length };
    `,

    /**
     * Clear captured console logs without stopping capture
     * Returns: { cleared: number }
     */
    clearConsoleLogs: `
        if (!window.__consoleCapture) {
            return { cleared: 0, error: 'Capture not started' };
        }
        const count = window.__consoleCapture.logs.length;
        window.__consoleCapture.logs = [];
        return { cleared: count };
    `,

    /**
     * Get browser console logs via WebDriver (if available)
     * Note: This uses performance.getEntries() to find script errors
     * Returns: { errors: [...], resources: [...] }
     */
    getResourceErrors: `
        const entries = performance.getEntriesByType('resource');
        const errors = [];
        const resources = [];
        
        entries.forEach(entry => {
            const info = {
                name: entry.name,
                type: entry.initiatorType,
                duration: Math.round(entry.duration),
                size: entry.transferSize || 0
            };
            
            // Check for failed resources (0 transfer size often indicates failure)
            if (entry.transferSize === 0 && entry.duration > 0) {
                errors.push({ ...info, error: 'possible_failure' });
            } else {
                resources.push(info);
            }
        });
        
        return { 
            errors: errors.slice(-20), 
            resources: resources.slice(-20),
            total: entries.length 
        };
    `,

    /**
     * Probe for blocked resources by attempting to fetch known tracker URLs
     * Args: [urls?: string[]] - Optional array of URLs to test (defaults to common trackers)
     * Returns: { blocked: [...], allowed: [...], errors: [...] }
     */
    probeBlockedResources: `
        const urlsToTest = arguments[0] || [
            'https://logx.optimizely.com/v1/events',
            'https://www.google-analytics.com/collect',
            'https://www.googletagmanager.com/gtm.js',
            'https://connect.facebook.net/en_US/fbevents.js',
            'https://bat.bing.com/bat.js',
            'https://pixel.advertising.com/pixel'
        ];
        
        const results = {
            blocked: [],
            allowed: [],
            errors: [],
            timestamp: new Date().toISOString(),
            url: location.href
        };
        
        // Test each URL with a quick fetch probe
        const probes = urlsToTest.map(async (url) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                
                const response = await fetch(url, {
                    method: 'HEAD',
                    mode: 'no-cors', // Allows blocked detection
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                // no-cors returns opaque response (type='opaque') if request went through
                // Content blocker will cause network error before response
                results.allowed.push({ url, status: 'reachable', type: response.type });
            } catch (e) {
                // Blocked by content blocker or CORS
                const isBlocked = e.message.includes('Failed to fetch') || 
                                 e.message.includes('NetworkError') ||
                                 e.message.includes('blocked') ||
                                 e.name === 'TypeError';
                
                if (isBlocked) {
                    results.blocked.push({ url, error: e.message, likely: 'content_blocker' });
                } else if (e.name === 'AbortError') {
                    results.errors.push({ url, error: 'timeout' });
                } else {
                    results.errors.push({ url, error: e.message });
                }
            }
        });
        
        await Promise.all(probes);
        return results;
    `,

    /**
     * Monitor network requests using PerformanceObserver (needs to be started early)
     * Mode: 'start' to begin, 'stop' to get results
     * Returns on stop: { requests: [...], failed: [...] }
     */
    networkMonitor: `
        const mode = arguments[0];
        
        if (mode === 'start') {
            window.__networkMonitor = {
                requests: [],
                observer: new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        window.__networkMonitor.requests.push({
                            name: entry.name,
                            type: entry.initiatorType,
                            duration: Math.round(entry.duration),
                            size: entry.transferSize || 0,
                            status: entry.responseStatus || 'unknown',
                            failed: entry.transferSize === 0 && entry.duration > 0
                        });
                    }
                })
            };
            window.__networkMonitor.observer.observe({ entryTypes: ['resource'] });
            return { status: 'monitoring' };
        }
        
        if (mode === 'stop') {
            if (!window.__networkMonitor) return { error: 'Monitor not started' };
            window.__networkMonitor.observer.disconnect();
            const requests = window.__networkMonitor.requests;
            delete window.__networkMonitor;
            
            return {
                requests: requests.filter(r => !r.failed),
                failed: requests.filter(r => r.failed),
                total: requests.length
            };
        }
        
        return { error: 'Invalid mode. Use "start" or "stop"' };
    `,

    /**
     * Get page state summary
     * Returns: { url, title, readyState, hasAlerts, scrollPosition, viewport }
     */
    pageState: `
        return {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            scrollPosition: { x: window.scrollX, y: window.scrollY },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            documentHeight: document.documentElement.scrollHeight,
            cookies: document.cookie.split(';').length,
            localStorage: Object.keys(localStorage).length,
            sessionStorage: Object.keys(sessionStorage).length
        };
    `
};

/**
 * Helper to run a debug script
 * @param {import('selenium-webdriver').WebDriver} driver - Selenium WebDriver instance
 * @param {keyof typeof debugScripts} scriptName - Name of script to run
 * @param {...any} args - Arguments to pass to the script
 * @returns {Promise<any>} Script result
 */
export async function runDebug(driver, scriptName, ...args) {
    const script = debugScripts[scriptName];
    if (!script) {
        throw new Error(`Unknown debug script: ${scriptName}`);
    }
    return await driver.executeScript(script, ...args);
}

/**
 * Log actionable elements in a readable format
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {Object} options
 * @param {string} [options.filter] - Filter by text content
 * @param {boolean} [options.linksOnly] - Only show links
 * @param {boolean} [options.buttonsOnly] - Only show buttons
 */
export async function logActionableElements(driver, options = {}) {
    const elements = await runDebug(driver, 'actionableElements');
    
    let filtered = elements;
    if (options.filter) {
        const pattern = options.filter.toLowerCase();
        filtered = elements.filter(e => (e.text || '').toLowerCase().includes(pattern));
    }
    if (options.linksOnly) {
        filtered = filtered.filter(e => e.tag === 'a');
    }
    if (options.buttonsOnly) {
        filtered = filtered.filter(e => e.tag !== 'a');
    }
    
    console.log(`\n🔍 Actionable elements (${filtered.length} found):`);
    
    const links = filtered.filter(e => e.tag === 'a');
    const buttons = filtered.filter(e => e.tag !== 'a');
    
    if (links.length > 0) {
        console.log('\n  Links:');
        links.forEach(e => {
            const hrefInfo = e.hrefType === 'hash-only' ? '⚠️ #' :
                           e.hrefType === 'javascript' ? '⚠️ js:' :
                           e.href?.substring(0, 50) || '';
            console.log(`    [${e.selector}] "${e.text}" → ${hrefInfo}`);
        });
    }
    
    if (buttons.length > 0) {
        console.log('\n  Buttons:');
        buttons.forEach(e => {
            const status = e.disabled ? '🔒' : e.hasClickHandler ? '✓' : '?';
            console.log(`    ${status} [${e.selector}] "${e.text}"`);
        });
    }
    
    return filtered;
}

/**
 * Log link analysis in a readable format
 * @param {import('selenium-webdriver').WebDriver} driver
 */
export async function logLinkAnalysis(driver) {
    const analysis = await runDebug(driver, 'linkAnalysis');
    
    console.log('\n🔗 Link Analysis:');
    console.log(`  Navigation links: ${analysis.navigation.length}`);
    console.log(`  JS-triggered (href="#" or javascript:): ${analysis.jsTriggered.length}`);
    console.log(`  External links: ${analysis.external.length}`);
    
    if (analysis.jsTriggered.length > 0) {
        console.log('\n  ⚠️ JS-triggered links (may not work with WebDriver click):');
        analysis.jsTriggered.slice(0, 10).forEach(l => {
            console.log(`    "${l.text}" → ${l.href}`);
        });
    }
    
    return analysis;
}

/**
 * Track DOM changes around an action
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {Function} action - Async function to execute
 * @returns {Promise<Object>} DOM changes
 */
export async function trackDomChanges(driver, action) {
    await runDebug(driver, 'domTracker', 'start');
    await action();
    // Small delay to let mutations settle
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await runDebug(driver, 'domTracker', 'stop');
}

/**
 * Start capturing console logs
 * @param {import('selenium-webdriver').WebDriver} driver
 */
export async function startConsoleCapture(driver) {
    return await runDebug(driver, 'startConsoleCapture');
}

/**
 * Get captured console logs
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {boolean} [stop=false] - Stop capturing after getting logs
 */
export async function getConsoleLogs(driver, stop = false) {
    return await runDebug(driver, 'getConsoleLogs', stop);
}

/**
 * Log console output in a readable format
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {Object} options
 * @param {boolean} [options.stop=false] - Stop capturing
 * @param {string[]} [options.levels] - Filter by levels (log, warn, error, info, debug, exception, rejection)
 */
export async function logConsoleLogs(driver, options = {}) {
    const { logs } = await getConsoleLogs(driver, options.stop);
    
    /** @type {Array<{level: string, message: string, timestamp: number}>} */
    let filtered = logs;
    if (options.levels) {
        filtered = logs.filter((/** @type {{level: string}} */ l) => options.levels?.includes(l.level));
    }
    
    if (filtered.length === 0) {
        console.log('\n📋 Console: (empty)');
        return filtered;
    }
    
    console.log(`\n📋 Console Logs (${filtered.length}):`);
    
    const levelIcons = {
        log: '  ',
        info: 'ℹ️',
        warn: '⚠️',
        error: '❌',
        debug: '🔍',
        exception: '💥',
        rejection: '💔'
    };
    
    filtered.forEach(entry => {
        const icon = levelIcons[entry.level] || '  ';
        const msg = entry.message.substring(0, 200);
        console.log(`  ${icon} [${entry.level}] ${msg}`);
    });
    
    return filtered;
}

/**
 * Capture console logs around an action
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {Function} action - Async function to execute
 * @returns {Promise<{logs: Array, result: any}>}
 */
export async function captureConsoleDuring(driver, action) {
    await startConsoleCapture(driver);
    const result = await action();
    await new Promise((resolve) => setTimeout(resolve, 300)); // Let async logs settle
    const { logs } = await getConsoleLogs(driver, true);
    return { logs, result };
}

/**
 * Probe for blocked resources (Content Blocker detection)
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {string[]} [urls] - Optional custom URLs to test
 * @returns {Promise<{blocked: Array, allowed: Array, errors: Array}>}
 */
export async function probeBlockedResources(driver, urls) {
    const results = await runDebug(driver, 'probeBlockedResources', urls);
    
    console.log(`\n🛡️ Content Blocker Probe Results:`);
    console.log(`   Page: ${results.url}`);
    
    if (results.blocked.length > 0) {
        console.log(`   ❌ BLOCKED (${results.blocked.length}):`);
        results.blocked.forEach(r => {
            console.log(`      - ${r.url}`);
        });
    }
    
    if (results.allowed.length > 0) {
        console.log(`   ✅ ALLOWED (${results.allowed.length}):`);
        results.allowed.forEach(r => {
            console.log(`      - ${r.url}`);
        });
    }
    
    if (results.errors.length > 0) {
        console.log(`   ⚠️ ERRORS (${results.errors.length}):`);
        results.errors.forEach(r => {
            console.log(`      - ${r.url}: ${r.error}`);
        });
    }
    
    return results;
}

/**
 * Start network monitoring
 * @param {import('selenium-webdriver').WebDriver} driver
 */
export async function startNetworkMonitor(driver) {
    return await runDebug(driver, 'networkMonitor', 'start');
}

/**
 * Stop network monitoring and get results
 * @param {import('selenium-webdriver').WebDriver} driver
 */
export async function stopNetworkMonitor(driver) {
    const results = await runDebug(driver, 'networkMonitor', 'stop');
    
    console.log(`\n📡 Network Monitor Results:`);
    console.log(`   Total requests: ${results.total}`);
    console.log(`   Successful: ${results.requests?.length || 0}`);
    console.log(`   Failed/Blocked: ${results.failed?.length || 0}`);
    
    if (results.failed?.length > 0) {
        console.log(`\n   ❌ Failed requests:`);
        results.failed.forEach(r => {
            console.log(`      - ${r.name} (${r.type})`);
        });
    }
    
    return results;
}

/**
 * Debug a click and report what happened
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {string} selector - CSS selector
 * @param {Object} [options]
 * @param {boolean} [options.captureConsole=true] - Capture console logs during click
 */
export async function debugClickElement(driver, selector, options = {}) {
    const { captureConsole = true } = options;
    
    console.log(`\n🖱️ Debug click on: ${selector}`);
    
    // Start DOM tracking
    await runDebug(driver, 'domTracker', 'start');
    
    // Start console capture if enabled
    if (captureConsole) {
        await runDebug(driver, 'startConsoleCapture');
    }
    
    // Execute click and capture events
    const clickResult = await runDebug(driver, 'debugClick', selector);
    
    // Small delay for any async effects
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    // Get DOM changes
    const domChanges = await runDebug(driver, 'domTracker', 'stop');
    
    // Get console logs
    /** @type {{logs: Array<{level: string, message: string}>}} */
    let consoleLogs = { logs: [] };
    if (captureConsole) {
        consoleLogs = await runDebug(driver, 'getConsoleLogs', true);
    }
    
    console.log(`  Element: <${clickResult.element?.tag}> "${clickResult.element?.text}"`);
    console.log(`  Events fired: ${clickResult.events?.map((/** @type {{type: string}} */ e) => e.type).join(', ') || 'none'}`);
    console.log(`  URL changed: ${clickResult.urlChanged}`);
    
    if (domChanges.added?.length > 0) {
        console.log(`  DOM added: ${domChanges.added.length} elements`);
        domChanges.added.slice(0, 3).forEach((/** @type {{tag: string, text?: string}} */ e) => {
            console.log(`    + <${e.tag}> ${e.text?.substring(0, 30)}`);
        });
    }
    
    if (domChanges.removed?.length > 0) {
        console.log(`  DOM removed: ${domChanges.removed.length} elements`);
    }
    
    if (consoleLogs.logs.length > 0) {
        console.log(`  Console output: ${consoleLogs.logs.length} message(s)`);
        const errors = consoleLogs.logs.filter((/** @type {{level: string}} */ l) => ['error', 'exception', 'rejection'].includes(l.level));
        if (errors.length > 0) {
            console.log(`  ❌ Errors during click:`);
            errors.slice(0, 3).forEach((/** @type {{message: string}} */ e) => {
                console.log(`    ${e.message.substring(0, 80)}`);
            });
        }
    }
    
    return { click: clickResult, dom: domChanges, console: consoleLogs };
}
