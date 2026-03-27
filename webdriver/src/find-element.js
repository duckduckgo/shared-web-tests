if (document.readyState !== 'complete') {
    return new Promise((resolve) => {
        window.addEventListener('load', async () => {
            const scriptResponse = await runScript();
            resolve(scriptResponse);
        });
    });
}

function selectElement(using, selector) {
    switch (using) {
        case 'id':
            return document.getElementById(selector);
        case 'css selector':
            return document.querySelector(selector);
        case 'link text':
            selector = `//a[contains(text(), '${selector}')]`;
        // fallthrough
        case 'xpath':
            return document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        case 'tag name':
            return document.getElementsByTagName(selector)[0] || null;
        case 'class name':
            return document.getElementsByClassName(selector)[0] || null;
        case 'name':
            return document.getElementsByName(selector)[0] || null;
        default:
            throw new Error('Unsupported locator strategy: ' + using);
    }
}

function runScript() {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        function findElement() {
            const element = selectElement(using, value);
            if (element !== null || attempts >= 5) {
                if (element === null) {
                    reject(new Error('Element not found after 5 attempts'));
                    return;
                }
                if (!window.__wdsr) {
                    // TODO make a WeakMap and handle references to elements with WeakRef or a similar mechanism
                    window.__wdsr = new Map();
                }
                let uuid;
                if (window.__wdsr.has(element)) {
                    uuid = window.__wdsr.get(element);
                } else {
                    uuid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
                    window.__wdsr.set(element, uuid);
                }
                resolve(uuid);
                return;
            }
            attempts++;
            const delay = Math.min(10 * Math.pow(2, attempts), 16000);
            setTimeout(findElement, delay);
        }
        findElement();
    });
}

return runScript();
