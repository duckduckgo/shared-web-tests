const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

function resolveElementRefs(args) {
    return args.map(arg => {
        if (arg && typeof arg === 'object' && arg[ELEMENT_KEY]) {
            const uuid = arg[ELEMENT_KEY];
            if (window.__webdriver_script_results) {
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === uuid) {
                        return el;
                    }
                }
            }
            throw new Error('Element not found for reference: ' + uuid);
        }
        return arg;
    });
}

const resolvedArgs = resolveElementRefs([__SCRIPT_ARGS__]);

const result = (function () {
    __SCRIPT__
}).apply(null, resolvedArgs);

if (result instanceof Element || result instanceof Document) {
    if (!window.__webdriver_script_results) {
        window.__webdriver_script_results = new Map();
    }
    let uuid;
    if (window.__webdriver_script_results.has(result)) {
        uuid = window.__webdriver_script_results.get(result);
    } else {
        uuid = generateUUID();
        window.__webdriver_script_results.set(result, uuid);
    }
    const elementRef = {};
    elementRef[ELEMENT_KEY] = uuid;
    return elementRef;
}
return result;
