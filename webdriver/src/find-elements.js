if (document.readyState !== 'complete') {
    return new Promise((resolve) => {
        window.addEventListener('load', async () => {
            const scriptResponse = await runScript();
            resolve(scriptResponse);
        });
    });
}

function selectElements(using, selector) {
    switch (using) {
        case 'id': {
            const el = document.getElementById(selector);
            return el ? [el] : [];
        }
        case 'css selector':
            return Array.from(document.querySelectorAll(selector));
        case 'link text': {
            // XPath for link text
            const xpath = `//a[contains(text(), '${selector}')]`;
            const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            const elements = [];
            for (let i = 0; i < result.snapshotLength; i++) {
                elements.push(result.snapshotItem(i));
            }
            return elements;
        }
        case 'xpath': {
            const xpathResult = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            const xpathElements = [];
            for (let i = 0; i < xpathResult.snapshotLength; i++) {
                xpathElements.push(xpathResult.snapshotItem(i));
            }
            return xpathElements;
        }
        case 'tag name':
            return Array.from(document.getElementsByTagName(selector));
        case 'class name':
            return Array.from(document.getElementsByClassName(selector));
        case 'name':
            return Array.from(document.getElementsByName(selector));
        default:
            throw new Error('Unsupported locator strategy: ' + using);
    }
}

function runScript() {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        function findElements() {
            try {
                if (typeof using === 'undefined' || typeof value === 'undefined') {
                    reject(new Error('using or value is undefined. using: ' + typeof using + ', value: ' + typeof value));
                    return;
                }
                // Ensure page is loaded before searching
                if (document.readyState !== 'complete' && attempts === 0) {
                    // Wait for page to be ready on first attempt
                    attempts++;
                    setTimeout(findElements, 100);
                    return;
                }
                // Debug logging
                console.log('FindElements: using=' + using + ', value=' + value);
                console.log('FindElements: document.readyState=' + document.readyState);
                console.log('FindElements: document.body exists=' + (document.body !== null));
                const elements = selectElements(using, value);
                console.log('FindElements: found ' + elements.length + ' elements');
                if (elements.length > 0 || attempts >= 5) {
                    if (elements.length === 0 && attempts >= 5) {
                        // Return debug info if no elements found after retries
                        // Try direct querySelectorAll to see if selector works
                        let directResult = 0;
                        try {
                            if (document.querySelectorAll) {
                                directResult = document.querySelectorAll(value).length;
                            }
                        } catch (e) {
                            directResult = 'error: ' + e.message;
                        }
                        const debugInfo = {
                            error: 'No elements found after 5 attempts',
                            using: typeof using === 'undefined' ? 'undefined' : using,
                            value: typeof value === 'undefined' ? 'undefined' : value,
                            readyState: document.readyState,
                            bodyExists: document.body !== null,
                            directQueryResult: directResult,
                            url: window.location.href,
                            buttonCount: document.querySelectorAll ? document.querySelectorAll('button').length : 'N/A',
                            inputButtonCount: document.querySelectorAll
                                ? document.querySelectorAll('input[type="button"], input[type="submit"]').length
                                : 'N/A',
                        };
                        console.error('FindElements debug:', JSON.stringify(debugInfo));
                        // Still return empty array as per WebDriver spec
                        resolve([]);
                        return;
                    }
                    if (!window.__webdriver_script_results) {
                        // TODO make a WeakMap and handle references to elements with WeakRef or a similar mechanism
                        window.__webdriver_script_results = new Map();
                    }
                    const uuids = [];
                    for (const element of elements) {
                        let uuid;
                        if (window.__webdriver_script_results.has(element)) {
                            uuid = window.__webdriver_script_results.get(element);
                        } else {
                            uuid = window.crypto.randomUUID();
                            window.__webdriver_script_results.set(element, uuid);
                        }
                        uuids.push(uuid);
                    }
                    resolve(uuids);
                    return;
                }
                attempts++;
                const delay = Math.min(10 * Math.pow(2, attempts), 16000);
                setTimeout(findElements, delay);
            } catch (error) {
                reject(new Error('Error in findElements: ' + error.message + '. Stack: ' + (error.stack || 'no stack')));
            }
        }
        findElements();
    });
}

return runScript();
