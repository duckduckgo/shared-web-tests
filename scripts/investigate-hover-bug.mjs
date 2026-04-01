/**
 * Hover State Bug Investigation
 *
 * Investigates the macOS browser hover state bug where mouseover/hover
 * interactions stop working across all web content. Tests event delivery,
 * CSS :hover pseudo-class application, and user script interference.
 *
 * Usage:
 *   npm run investigate:hover -- --no-keep
 *   npm run investigate:hover -- --screenshot
 *   npm run investigate:hover -- --url https://example.com
 */

import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);

/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep') || !args.includes('--no-keep');
const takeScreenshots = args.includes('--screenshot');
const customUrl = args.find((_, i, a) => a[i - 1] === '--url');
const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

async function cleanupExistingSessions() {
    try {
        const response = await fetch(`${serverUrl}/sessions`);
        if (response.ok) {
            const data = await response.json();
            const sessions = data.value || (Array.isArray(data) ? data : []);
            for (const session of sessions) {
                const sessionId = session.id || session.sessionId || session;
                await fetch(`${serverUrl}/session/${sessionId}`, { method: 'DELETE' }).catch(() => {});
            }
            if (sessions.length > 0) await new Promise((resolve) => setTimeout(resolve, 500));
        }
    } catch {
        // Server not running
    }
}

async function waitForPageReady(driver, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const readyState = await driver.executeScript('return document.readyState');
            if (readyState === 'complete') {
                await new Promise((resolve) => setTimeout(resolve, 300));
                return true;
            }
        } catch {
            // retry
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
}

async function saveScreenshot(driver, name) {
    const screenshotsDir = join(scriptsDir, '..', 'screenshots', 'hover-investigation');
    try {
        await mkdir(screenshotsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${name}-${timestamp}.png`;
        const screenshotBase64 = await driver.takeScreenshot();
        const filepath = join(screenshotsDir, filename);
        await writeFile(filepath, Buffer.from(screenshotBase64, 'base64'));
        console.log(`    Screenshot: ${filepath}`);
        return filepath;
    } catch (e) {
        console.error(`    Failed to save screenshot: ${e.message}`);
        return null;
    }
}

/**
 * Safely run executeScript and return null on error instead of throwing
 */
async function safeExecute(driver, script, ...args) {
    try {
        return await driver.executeScript(script, ...args);
    } catch (e) {
        return { __error: e.message };
    }
}

/**
 * Inject test page HTML into the current about:blank page
 */
async function injectTestPage(driver) {
    await safeExecute(
        driver,
        `
        document.open();
        document.write(\`<!DOCTYPE html>
<html>
<head><title>Hover Bug Investigation</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 20px; background: #fff; }
  .test-box { width: 200px; height: 100px; margin: 10px; background: #e0e0e0;
    display: inline-flex; align-items: center; justify-content: center;
    transition: background 0.1s; border: 2px solid transparent; cursor: pointer; }
  .test-box:hover { background: #4CAF50; color: white; border-color: #2E7D32; }
  .tooltip-trigger { position: relative; }
  .tooltip-trigger .tooltip { display: none; position: absolute; top: -30px; left: 50%;
    transform: translateX(-50%); background: #333; color: white; padding: 4px 8px;
    border-radius: 4px; font-size: 12px; white-space: nowrap; }
  .tooltip-trigger:hover .tooltip { display: block; }
  a:hover { color: red; text-decoration: underline; }
  button:hover { background: #1976D2; color: white; }
</style></head>
<body>
<h1>Hover Bug Investigation</h1>
<div id="test-area">
  <div class="test-box" id="box1">Box 1</div>
  <div class="test-box tooltip-trigger" id="box2">Box 2<span class="tooltip">Tooltip visible</span></div>
  <div class="test-box" id="box3">Box 3</div>
  <br><a href="#" id="test-link">Hover this link</a>
  <button id="test-button" style="margin-left:10px">Hover this button</button>
</div>
<div id="results" style="margin-top:20px"></div>
</body></html>\`);
        document.close();
    `,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * Test 1: Check if mouse events are being delivered to the page
 */
async function testEventDelivery(driver) {
    console.log('\n--- Test 1: Mouse Event Delivery ---');

    const results = await safeExecute(
        driver,
        `
        const events = [];
        const box = document.getElementById('box1');
        if (!box) return { error: 'box1 not found' };

        // Register listeners
        ['mouseover','mouseenter','mousemove','mouseout','mouseleave',
         'pointerover','pointerenter','pointermove','pointerout','pointerleave'].forEach(type => {
            box.addEventListener(type, (e) => {
                events.push({ type: type, target: e.target?.id || e.target?.tagName, cx: e.clientX, cy: e.clientY });
            }, { once: true });
        });

        const rect = box.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        // Dispatch synthetic hover events
        const types = ['pointerover','pointerenter','mouseover','mouseenter','pointermove','mousemove'];
        for (const type of types) {
            const isPointer = type.startsWith('pointer');
            const EC = isPointer ? PointerEvent : MouseEvent;
            box.dispatchEvent(new EC(type, {
                bubbles: !type.includes('enter'), cancelable: true,
                clientX: cx, clientY: cy, view: window,
                ...(isPointer ? { pointerId: 1, pointerType: 'mouse' } : {})
            }));
        }

        return { eventsReceived: events.length, eventTypes: events.map(e => e.type) };
    `,
    );

    if (results?.__error) {
        console.log(`  ERROR: ${results.__error}`);
        return { pass: false, error: results.__error };
    }
    if (results?.error) {
        console.log(`  FAIL: ${results.error}`);
        return { pass: false, error: results.error };
    }

    const expectedTypes = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'];
    const received = new Set(results.eventTypes || []);
    const missing = expectedTypes.filter((t) => !received.has(t));

    console.log(`  Events received: ${results.eventsReceived}`);
    console.log(`  Event types: ${(results.eventTypes || []).join(', ')}`);
    if (missing.length > 0) console.log(`  MISSING events: ${missing.join(', ')}`);

    const pass = missing.length === 0;
    console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    return { pass, received: results.eventTypes, missing, totalEvents: results.eventsReceived };
}

/**
 * Test 2: Check if CSS :hover pseudo-class is in resting (unhovered) state
 */
async function testCSSHoverState(driver) {
    console.log('\n--- Test 2: CSS :hover State ---');

    const results = await safeExecute(
        driver,
        `
        const box = document.getElementById('box1');
        if (!box) return { error: 'box1 not found' };

        const tooltip = document.querySelector('#box2 .tooltip');
        return {
            defaultBg: getComputedStyle(box).backgroundColor,
            matchesHover: box.matches(':hover'),
            tooltipDisplay: tooltip ? getComputedStyle(tooltip).display : 'N/A'
        };
    `,
    );

    if (results?.__error) {
        console.log(`  ERROR: ${results.__error}`);
        return { pass: false, error: results.__error };
    }

    console.log(`  Default background: ${results.defaultBg}`);
    console.log(`  Matches :hover: ${results.matchesHover}`);
    console.log(`  Tooltip display: ${results.tooltipDisplay}`);

    const pass = !results.matchesHover && results.tooltipDisplay === 'none';
    console.log(`  Result: ${pass ? 'PASS (resting state correct)' : 'UNEXPECTED (:hover stuck?)'}`);
    return { pass, ...results };
}

/**
 * Test 3: Check for event listener interference from user scripts
 */
async function testEventListenerInterference(driver) {
    console.log('\n--- Test 3: Event Listener Interference ---');

    const results = await safeExecute(
        driver,
        `
        const r = {};

        // Check EventTarget methods are native
        r.addEventListenerNative = EventTarget.prototype.addEventListener.toString().includes('[native code]');
        r.removeEventListenerNative = EventTarget.prototype.removeEventListener.toString().includes('[native code]');
        r.dispatchEventNative = EventTarget.prototype.dispatchEvent.toString().includes('[native code]');

        // Check for proxied methods
        try {
            r.addEventListenerStr = EventTarget.prototype.addEventListener.toString().substring(0, 80);
        } catch (e) {
            r.addEventListenerStr = 'toString() threw: ' + e.message;
        }

        // Check if custom events propagate correctly
        let customReceived = false;
        const h = () => { customReceived = true; };
        document.body.addEventListener('__test__', h);
        document.body.dispatchEvent(new Event('__test__'));
        document.body.removeEventListener('__test__', h);
        r.customEventWorks = customReceived;

        // Test mouseover propagation through DOM
        const parent = document.createElement('div');
        const child = document.createElement('div');
        parent.appendChild(child);
        document.body.appendChild(parent);
        const phases = [];
        parent.addEventListener('mouseover', () => phases.push('parent-capture'), true);
        child.addEventListener('mouseover', () => phases.push('child'), false);
        parent.addEventListener('mouseover', () => phases.push('parent-bubble'), false);
        child.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        document.body.removeChild(parent);
        r.bubblePhases = phases;
        r.bubblingWorks = phases.includes('parent-bubble') && phases.includes('child');

        // Check if stopPropagation or preventDefault is being called by anything
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        let propagationStopped = false;
        let defaultPrevented = false;
        document.addEventListener('mouseover', (e) => {
            propagationStopped = e.cancelBubble;
            defaultPrevented = e.defaultPrevented;
        }, { once: true });
        probe.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        document.body.removeChild(probe);
        r.propagationStopped = propagationStopped;
        r.defaultPrevented = defaultPrevented;

        return r;
    `,
    );

    if (results?.__error) {
        console.log(`  ERROR: ${results.__error}`);
        return { pass: false, error: results.__error };
    }

    console.log(`  addEventListener native: ${results.addEventListenerNative}`);
    console.log(`  removeEventListener native: ${results.removeEventListenerNative}`);
    console.log(`  dispatchEvent native: ${results.dispatchEventNative}`);
    console.log(`  addEventListener toString: ${results.addEventListenerStr}`);
    console.log(`  Custom event works: ${results.customEventWorks}`);
    console.log(`  Bubble phases: ${(results.bubblePhases || []).join(' -> ')}`);
    console.log(`  Bubbling works: ${results.bubblingWorks}`);
    console.log(`  Propagation stopped: ${results.propagationStopped}`);
    console.log(`  Default prevented: ${results.defaultPrevented}`);

    const pass =
        results.addEventListenerNative &&
        results.customEventWorks &&
        results.bubblingWorks &&
        !results.propagationStopped &&
        !results.defaultPrevented;
    console.log(`  Result: ${pass ? 'PASS (no interference)' : 'FAIL (interference detected)'}`);
    return { pass, ...results };
}

/**
 * Test 4: Check for pointer-events CSS interference and overlays
 */
async function testPointerEventsCSS(driver) {
    console.log('\n--- Test 4: Pointer Events CSS Interference ---');

    const results = await safeExecute(
        driver,
        `
        const r = {
            bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
            htmlPointerEvents: getComputedStyle(document.documentElement).pointerEvents,
            blockedElements: [],
            overlays: []
        };

        for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            if (s.pointerEvents === 'none') {
                r.blockedElements.push({ tag: el.tagName, id: el.id, cls: (el.className||'').toString().substring(0,40) });
            }
            const rect = el.getBoundingClientRect();
            if (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5 &&
                (parseInt(s.zIndex) > 100 || s.position === 'fixed' || s.position === 'absolute') &&
                el !== document.body && el !== document.documentElement && s.display !== 'none') {
                r.overlays.push({ tag: el.tagName, id: el.id, z: s.zIndex, pos: s.position, opacity: s.opacity, pe: s.pointerEvents });
            }
        }
        return r;
    `,
    );

    if (results?.__error) {
        console.log(`  ERROR: ${results.__error}`);
        return { pass: false, error: results.__error };
    }

    console.log(`  body pointer-events: ${results.bodyPointerEvents}`);
    console.log(`  html pointer-events: ${results.htmlPointerEvents}`);
    console.log(`  Elements with pointer-events:none: ${results.blockedElements?.length || 0}`);
    results.blockedElements?.forEach((el) => console.log(`    <${el.tag}> #${el.id} .${el.cls}`));
    console.log(`  Potential overlays: ${results.overlays?.length || 0}`);
    results.overlays?.forEach((o) => console.log(`    <${o.tag}> #${o.id} z:${o.z} opacity:${o.opacity} pe:${o.pe}`));

    const pass = results.bodyPointerEvents !== 'none' && results.htmlPointerEvents !== 'none';
    console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    return { pass, ...results };
}

/**
 * Test 5: Enumerate user scripts and check for hover-related code
 */
async function testUserScriptEnumeration(driver) {
    console.log('\n--- Test 5: User Script Enumeration ---');

    const results = await safeExecute(
        driver,
        `
        const r = { scripts: [], ddgScripts: [], hoverRelated: [], handlers: null, globals: {}, ddgAttrs: [] };

        document.querySelectorAll('script').forEach((s, i) => {
            if (s.src) {
                r.scripts.push({ i: i, src: s.src });
                if (s.src.includes('duckduckgo') || s.src.includes('ddg')) r.ddgScripts.push(s.src);
            } else if (s.textContent && s.textContent.length > 10) {
                const txt = s.textContent;
                const preview = txt.substring(0, 100);
                r.scripts.push({ i: i, len: txt.length, preview: preview });
                for (const p of ['mouseover','mouseenter','pointerover','pointerenter',':hover','onmouseover']) {
                    if (txt.includes(p)) r.hoverRelated.push({ pattern: p, script: i, ctx: txt.substring(Math.max(0,txt.indexOf(p)-30), txt.indexOf(p)+40) });
                }
            }
        });

        // Webkit message handlers (DDG injection mechanism on macOS/iOS)
        try {
            if (window.webkit && window.webkit.messageHandlers) {
                const keys = [];
                // Proxy may block getOwnPropertyNames, so try-catch
                try { keys.push(...Object.getOwnPropertyNames(window.webkit.messageHandlers)); } catch {}
                try { keys.push(...Object.keys(window.webkit.messageHandlers)); } catch {}
                r.handlers = [...new Set(keys)];
            }
        } catch { r.handlers = 'inaccessible'; }

        // DDG globals
        for (const g of ['__ddg_tds','__ddg_ext','duckduckgo','__DDG_CONTENT_SCOPE']) {
            if (g in window) r.globals[g] = typeof window[g];
        }

        // DDG data attributes on <html>
        for (const attr of document.documentElement.attributes) {
            if (attr.name.startsWith('data-ddg')) r.ddgAttrs.push({ name: attr.name, value: attr.value });
        }

        return r;
    `,
    );

    if (results?.__error) {
        console.log(`  ERROR: ${results.__error}`);
        return { pass: true, error: results.__error };
    }

    console.log(`  Total scripts: ${results.scripts?.length || 0}`);
    console.log(`  DDG scripts: ${results.ddgScripts?.length || 0}`);
    console.log(`  Hover-related code: ${results.hoverRelated?.length || 0}`);
    results.hoverRelated?.forEach((h) => console.log(`    "${h.pattern}" in script#${h.script}: ...${h.ctx}...`));
    console.log(`  Webkit handlers: ${JSON.stringify(results.handlers)}`);
    console.log(`  DDG globals: ${JSON.stringify(results.globals)}`);
    console.log(`  DDG attrs: ${JSON.stringify(results.ddgAttrs)}`);

    return { pass: true, ...results };
}

/**
 * Test 6: Document visibility and focus state
 */
async function testVisibilityState(driver) {
    console.log('\n--- Test 6: Document Visibility & Focus State ---');

    const results = await safeExecute(
        driver,
        `
        return {
            visibilityState: document.visibilityState,
            hidden: document.hidden,
            hasFocus: document.hasFocus(),
            activeElement: document.activeElement?.tagName
        };
    `,
    );

    if (results?.__error) {
        console.log(`  ERROR: ${results.__error}`);
        return { pass: false, error: results.__error };
    }

    console.log(`  Visibility state: ${results.visibilityState}`);
    console.log(`  Document hidden: ${results.hidden}`);
    console.log(`  Document has focus: ${results.hasFocus}`);
    console.log(`  Active element: ${results.activeElement}`);

    const pass = results.visibilityState === 'visible' && !results.hidden;
    console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    return { pass, ...results };
}

/**
 * Test 7: Test hover on a real website
 */
async function testRealSiteHover(driver, url) {
    console.log(`\n--- Test 7: Real Site Hover Test (${url}) ---`);

    await driver.get(url);
    await waitForPageReady(driver);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const results = await safeExecute(
        driver,
        `
        const r = {
            url: location.href,
            title: document.title,
            hoverCSSRules: 0,
            eventTargetIntact: EventTarget.prototype.addEventListener.toString().includes('[native code]'),
            bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
            overlays: 0,
            scriptCount: document.querySelectorAll('script').length,
            syntheticEventDelivered: false
        };

        // Count hover CSS rules
        try {
            for (const sheet of document.styleSheets) {
                try { for (const rule of sheet.cssRules) { if (rule.selectorText?.includes(':hover')) r.hoverCSSRules++; } }
                catch {}
            }
        } catch {}

        // Count overlays
        for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (rect.width > window.innerWidth * 0.8 && rect.height > window.innerHeight * 0.8 &&
                (parseInt(s.zIndex) > 100 || s.position === 'fixed') &&
                el !== document.body && el !== document.documentElement && s.display !== 'none') r.overlays++;
        }

        // Test synthetic event delivery
        const target = document.querySelector('a, button, [role="button"]');
        if (target) {
            target.addEventListener('mouseover', () => { r.syntheticEventDelivered = true; }, { once: true });
            target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            r.testTarget = target.tagName;
        }

        // Check for DDG content scope
        r.hasWebkitHandlers = !!(window.webkit && window.webkit.messageHandlers);
        r.ddgGlobals = {};
        for (const g of ['__ddg_tds','duckduckgo','__DDG_CONTENT_SCOPE']) {
            if (g in window) r.ddgGlobals[g] = typeof window[g];
        }

        return r;
    `,
    );

    if (results?.__error) {
        console.log(`  ERROR: ${results.__error}`);
        return { pass: false, error: results.__error };
    }

    console.log(`  URL: ${results.url}`);
    console.log(`  Title: ${results.title}`);
    console.log(`  Hover CSS rules: ${results.hoverCSSRules}`);
    console.log(`  EventTarget intact: ${results.eventTargetIntact}`);
    console.log(`  body pointer-events: ${results.bodyPointerEvents}`);
    console.log(`  Large overlays: ${results.overlays}`);
    console.log(`  Scripts: ${results.scriptCount}`);
    console.log(`  Synthetic event delivered: ${results.syntheticEventDelivered}`);
    console.log(`  Webkit handlers present: ${results.hasWebkitHandlers}`);
    console.log(`  DDG globals: ${JSON.stringify(results.ddgGlobals)}`);

    if (takeScreenshots) await saveScreenshot(driver, 'real-site');

    const pass = results.eventTargetIntact && results.bodyPointerEvents !== 'none' && results.syntheticEventDelivered;
    console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    return { pass, ...results };
}

/**
 * Test 8: Multi-site comparison (test multiple sites for consistent behavior)
 */
async function testMultipleSites(driver) {
    console.log('\n--- Test 8: Multi-Site Hover Comparison ---');

    const sites = ['https://en.wikipedia.org/wiki/Main_Page', 'https://github.com', 'https://www.youtube.com'];
    const siteResults = [];

    for (const site of sites) {
        try {
            await driver.get(site);
            await waitForPageReady(driver);
            await new Promise((resolve) => setTimeout(resolve, 1500));

            const result = await safeExecute(
                driver,
                `
                const r = { url: location.href, ok: true };
                // EventTarget intact
                r.eventTargetIntact = EventTarget.prototype.addEventListener.toString().includes('[native code]');
                // pointer-events
                r.bodyPE = getComputedStyle(document.body).pointerEvents;
                // Synthetic event test
                const t = document.querySelector('a, button');
                if (t) {
                    let got = false;
                    t.addEventListener('mouseover', () => { got = true; }, { once: true });
                    t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    r.eventDelivered = got;
                } else { r.eventDelivered = 'no target'; }
                // DuckPlayer specific: check for thumbnail overlays on YouTube
                if (location.hostname.includes('youtube')) {
                    r.duckPlayerOverlay = !!document.querySelector('[class*="ddg"], [data-ddg]');
                    r.thumbnailLinks = document.querySelectorAll('a#thumbnail').length;
                }
                return r;
            `,
            );

            if (result?.__error) {
                siteResults.push({ site, error: result.__error });
                console.log(`  ${site}: ERROR - ${result.__error}`);
            } else {
                siteResults.push({ site, ...result });
                console.log(`  ${site}: ET=${result.eventTargetIntact} PE=${result.bodyPE} Event=${result.eventDelivered}`);
                if (result.duckPlayerOverlay !== undefined) {
                    console.log(`    DuckPlayer overlay: ${result.duckPlayerOverlay}, Thumbnails: ${result.thumbnailLinks}`);
                }
            }
        } catch (e) {
            siteResults.push({ site, error: e.message });
            console.log(`  ${site}: ERROR - ${e.message}`);
        }
    }

    const allPassed = siteResults.every((r) => !r.error && r.eventTargetIntact && r.eventDelivered === true);
    console.log(`  Result: ${allPassed ? 'PASS (all sites consistent)' : 'MIXED/FAIL'}`);
    return { pass: allPassed, sites: siteResults };
}

/**
 * Test 9: Check DuckPlayer thumbnail overlay specifically (YouTube hover listener)
 */
async function testDuckPlayerHover(driver) {
    console.log('\n--- Test 9: DuckPlayer Thumbnail Hover (YouTube) ---');

    await driver.get('https://www.youtube.com');
    await waitForPageReady(driver);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const results = await safeExecute(
        driver,
        `
        const r = {
            url: location.href,
            thumbnails: document.querySelectorAll('a#thumbnail, ytd-thumbnail').length,
            ddgElements: document.querySelectorAll('[class*="ddg"], [data-ddg]').length,
            mouseoverListenerCount: 0
        };

        // Check for DuckPlayer-injected event listeners by looking for DDG overlay elements
        const daxIcons = document.querySelectorAll('[class*="dax"], [class*="duck-player"], [class*="ddg-overlay"]');
        r.daxIcons = daxIcons.length;

        // Check if DuckPlayer thumbnails feature is active by looking for its CSS
        const sheets = document.styleSheets;
        let ddgStyles = 0;
        try {
            for (const sheet of sheets) {
                try {
                    const href = sheet.href || '';
                    if (href.includes('ddg') || href.includes('duckduckgo')) ddgStyles++;
                    for (const rule of sheet.cssRules) {
                        if (rule.selectorText?.includes('ddg') || rule.selectorText?.includes('dax')) ddgStyles++;
                    }
                } catch {}
            }
        } catch {}
        r.ddgStyleRules = ddgStyles;

        // Try to trigger a mouseover on a thumbnail to see if DuckPlayer responds
        const thumb = document.querySelector('a#thumbnail');
        if (thumb) {
            const rect = thumb.getBoundingClientRect();
            const events = [];
            const handler = (e) => events.push(e.type);
            thumb.addEventListener('mouseover', handler);
            document.addEventListener('mouseover', (e) => events.push('doc:' + e.type), { once: true });

            thumb.dispatchEvent(new MouseEvent('mouseover', {
                bubbles: true, cancelable: true,
                clientX: rect.left + 10, clientY: rect.top + 10,
                view: window
            }));

            // Wait for any async DuckPlayer handlers
            await new Promise(res => setTimeout(res, 300));

            thumb.removeEventListener('mouseover', handler);
            r.thumbnailHoverEvents = events;
            r.thumbnailHref = thumb.href;
        }

        return r;
    `,
    );

    if (results?.__error) {
        console.log(`  ERROR: ${results.__error}`);
        return { pass: true, error: results.__error, note: 'YouTube may have loaded differently' };
    }

    console.log(`  URL: ${results.url}`);
    console.log(`  Thumbnails found: ${results.thumbnails}`);
    console.log(`  DDG elements: ${results.ddgElements}`);
    console.log(`  Dax icons: ${results.daxIcons}`);
    console.log(`  DDG style rules: ${results.ddgStyleRules}`);
    console.log(`  Thumbnail hover events: ${JSON.stringify(results.thumbnailHoverEvents)}`);
    console.log(`  Thumbnail href: ${results.thumbnailHref}`);

    if (takeScreenshots) await saveScreenshot(driver, 'youtube-duckplayer');

    return { pass: true, ...results };
}

// ---- Main ----

await cleanupExistingSessions();

let driver;
try {
    driver = await new selenium.Builder().usingServer(serverUrl).withCapabilities({ browserName: 'duckduckgo' }).build();

    console.log('='.repeat(60));
    console.log('HOVER STATE BUG INVESTIGATION');
    console.log('='.repeat(60));
    console.log(`Time: ${new Date().toISOString()}`);

    // Navigate to about:blank first, then inject test HTML
    console.log('\nSetting up inline test page...');
    await driver.get('https://example.com');
    await waitForPageReady(driver);
    await injectTestPage(driver);
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (takeScreenshots) await saveScreenshot(driver, 'test-page-setup');

    const allResults = {};

    // Run tests on the injected test page
    allResults.eventDelivery = await testEventDelivery(driver);
    allResults.cssHover = await testCSSHoverState(driver);
    allResults.listenerInterference = await testEventListenerInterference(driver);
    allResults.pointerEventsCSS = await testPointerEventsCSS(driver);
    allResults.userScripts = await testUserScriptEnumeration(driver);
    allResults.visibilityState = await testVisibilityState(driver);

    // Test on real sites
    const testUrl = customUrl || 'https://duckduckgo.com';
    allResults.realSite = await testRealSiteHover(driver, testUrl);
    allResults.multiSite = await testMultipleSites(driver);
    allResults.duckPlayer = await testDuckPlayerHover(driver);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('INVESTIGATION SUMMARY');
    console.log('='.repeat(60));

    const tests = Object.entries(allResults);
    let passCount = 0;
    let failCount = 0;

    for (const [name, result] of tests) {
        const status = result.pass ? 'PASS' : 'FAIL';
        if (result.pass) passCount++;
        else failCount++;
        console.log(`  ${status}  ${name}${result.error ? ` (${result.error.substring(0, 60)})` : ''}`);
    }

    console.log(`\n  Total: ${passCount} passed, ${failCount} failed out of ${tests.length}`);

    // Key findings
    console.log('\n--- Key Findings ---');

    if (allResults.listenerInterference && !allResults.listenerInterference.pass) {
        console.log('  [!] EVENT LISTENER INTERFERENCE DETECTED');
        if (!allResults.listenerInterference.addEventListenerNative) {
            console.log('      addEventListener has been overridden (not native code)');
            console.log(`      toString: ${allResults.listenerInterference.addEventListenerStr}`);
        }
        if (allResults.listenerInterference.propagationStopped) {
            console.log('      mouseover propagation is being stopped');
        }
        if (allResults.listenerInterference.defaultPrevented) {
            console.log('      mouseover default is being prevented');
        }
    }

    if (allResults.pointerEventsCSS && !allResults.pointerEventsCSS.pass) {
        console.log('  [!] POINTER EVENTS CSS INTERFERENCE DETECTED');
    }

    if (allResults.userScripts?.hoverRelated?.length > 0) {
        console.log('  [!] USER SCRIPTS WITH HOVER CODE FOUND');
        allResults.userScripts.hoverRelated.forEach((h) => {
            console.log(`      Pattern "${h.pattern}" in script#${h.script}`);
        });
    }

    if (allResults.visibilityState && !allResults.visibilityState.pass) {
        console.log('  [!] DOCUMENT VISIBILITY STATE ISSUE');
        console.log(`      visibilityState: ${allResults.visibilityState.visibilityState}`);
        console.log(`      hidden: ${allResults.visibilityState.hidden}`);
    }

    if (allResults.duckPlayer?.daxIcons > 0 || allResults.duckPlayer?.ddgStyleRules > 0) {
        console.log('  [i] DuckPlayer is active on YouTube');
        console.log(`      Dax icons: ${allResults.duckPlayer.daxIcons}, DDG styles: ${allResults.duckPlayer.ddgStyleRules}`);
    }

    if (allResults.multiSite?.sites?.some((s) => !s.eventTargetIntact)) {
        console.log('  [!] EventTarget overridden on some sites');
    }

    console.log('\n--- Investigation Notes ---');
    console.log('  This test checks the JavaScript event delivery layer.');
    console.log('  The reported bug affects REAL mouse hardware events, not dispatchEvent.');
    console.log('  Synthetic events (dispatchEvent) bypass the browser compositing layer.');
    console.log('  The Zoom screen-sharing fix suggests a WKWebView/CALayer compositing issue.');
    console.log('  Key suspects:');
    console.log('    1. WKWebView hit-testing state corruption (native, not JS)');
    console.log('    2. User script installing a capturing listener that swallows events');
    console.log('    3. Window/layer compositing issue with external displays');

    console.log('\n' + '='.repeat(60));

    // Save full report
    const reportDir = join(scriptsDir, '..', 'reports');
    await mkdir(reportDir, { recursive: true });
    const reportFile = join(reportDir, `hover-investigation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(reportFile, JSON.stringify({ timestamp: new Date().toISOString(), results: allResults }, null, 2));
    console.log(`\nReport saved: ${reportFile}`);

    if (keepOpen) {
        console.log('\nBrowser staying open. Press Ctrl+C to quit.');
        await new Promise(() => {});
    }
} catch (error) {
    console.error('\nError:', error.message);
    if (error.message.includes('ECONNREFUSED')) {
        console.error('Driver not running. Start with: npm run driver:macos');
    }
    process.exit(1);
} finally {
    if (driver && !keepOpen) {
        try {
            await driver.quit();
        } catch {
            // Ignore
        }
    }
}
