if (document.readyState != 'complete') {
    return new Promise((resolve) => {
        window.addEventListener('load', async () => {
            let scriptResponse = await runScript();
            resolve(scriptResponse);
        });
    });
}

function selectElement(using, selector) {
    switch (using) {
        case 'css selector':
            return document.querySelector(selector);
        case 'link text':
            selector = `//a[contains(text(), '${selector}')]`;
        case 'xpath':
            return document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        default:
            throw new Error('Unsupported locator strategy: ' + using);
    } 
}


function runScript() {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        function findElement() {
            let element = selectElement(using, value);
            if (element !== null || attempts >= 5) {
                if (element === null) {
                    reject(new Error('Element not found after 5 attempts'));
                    return;
                }
                if (!window.__webdriver_script_results) {
                    // TODO make a WeakMap and handle references to elements with WeakRef or a similar mechanism
                    window.__webdriver_script_results = new Map();
                }
                let uuid;
                if (window.__webdriver_script_results.has(element)) {
                    uuid = window.__webdriver_script_results.get(element);
                } else {
                    uuid = window.crypto.randomUUID();
                    window.__webdriver_script_results.set(element, uuid);
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