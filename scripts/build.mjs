import { copyFileSync, existsSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// copy testharness code to build
copyFile('web-platform-tests', 'resources/testharness.js');
copyFile('web-platform-tests', 'resources/testharnessreport.js');
copyFile('web-platform-tests', 'resources/testdriver.js');
copyFile('web-platform-tests', 'resources/web-extensions-helper.js');
copyFileAs(
  'web-platform-tests/tools/wptrunner/wptrunner',
  'testdriver-vendor.js',
  'resources/testdriver-vendor.js'
);
// Copy package.json
copyFile('.', 'package.json');
// Example test files
copyFile('web-platform-tests', 'referrer-policy/generic/test-case.sub.js');

[
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/context-for-location.html',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/resources/context-helper.js',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/resources/target.js',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/entry/entry.html',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/entry/target.html',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/incumbent/empty.html',
  'html/browsers/browsing-the-web/navigating-across-documents/multiple-globals/relevant/empty.html',

  'html/browsers/windows/embedded-opener-a-form.html',
].forEach(file => copyFile('web-platform-tests', file));

[
  'wpt',
].forEach(file => copyFile('web-platform-tests', file));


// Copy whole directory
const copyDirectories = [
  'docs',
  'tools',
  'common',
  'web-extensions'
];
copyDirectories.forEach(dir => {
  rmSync(`build/${dir}`, { recursive: true, force: true });
  cpSync(`web-platform-tests/${dir}`, `build/${dir}`, { recursive: true, force: true });
})

applyDuckDuckGoPatches();

const currentDir = process.cwd() + '/build';
const config = {
  "doc_root": currentDir
}
// write a JSON file
writeFileSync('build/wpt.config.json', JSON.stringify(config, null, 2));

// Run cli command
const buildManifest = `./web-platform-tests/wpt manifest --tests-root ${currentDir} --no-download -v`;
execSync(buildManifest, { stdio: 'inherit' });

function copyFile(from, file) {
    // Get filename
    const fileParts = file.split('/');
    const filename = fileParts[fileParts.length - 1];
    const dir = fileParts.slice(0, -1).join('/');
    const buildDir = join('build', dir);
    const testharnessDest = join(buildDir, filename);
    if (!existsSync(buildDir)) {
      mkdirSync(buildDir, { recursive: true });
    }
    copyFileSync(join(from, file), testharnessDest);
}

function copyFileAs(from, sourceFile, destinationFile) {
    const destinationParts = destinationFile.split('/');
    const filename = destinationParts[destinationParts.length - 1];
    const dir = destinationParts.slice(0, -1).join('/');
    const buildDir = join('build', dir);
    const destinationPath = join(buildDir, filename);
    if (!existsSync(buildDir)) {
      mkdirSync(buildDir, { recursive: true });
    }
    copyFileSync(join(from, sourceFile), destinationPath);
}

function applyDuckDuckGoPatches() {
    insertBefore(
      'build/tools/wpt/browser.py',
      'class WebKitTestRunner(Browser):',
      `
class DuckDuckGo(Browser):
    product = "duckduckgo"
    requirements = None

    def download(self, dest=None, channel=None, rename=None):
        raise NotImplementedError

    def install(self, dest=None, channel=None):
        raise NotImplementedError

    def find_binary(self, venv_path=None, channel=None):
        return which("duckduckgo")

    def find_webdriver(self, venv_path=None, channel=None):
        return which("WebDriver")

    def install_webdriver(self, dest=None, channel=None, browser_binary=None):
        raise NotImplementedError

    def version(self, binary=None, webdriver_binary=None):
        if not binary:
            self.logger.warning("No browser binary provided.")
            return None
        output = call(binary, "--version")
        if output:
            version_string = output.strip()
            match = re.match(r"Version (.*)", version_string)
            if match:
                return match.group(1)
        return None
`
    );

    insertBefore(
      'build/tools/wpt/run.py',
      'class WebKitTestRunner(BrowserSetup):',
      `
class DuckDuckGoBrowser(BrowserSetup):
    name = "duckduckgo"
    browser_cls = browser.DuckDuckGo

    def install(self, channel=None):
        raise NotImplementedError

    def setup_kwargs(self, kwargs):
        kwargs["webdriver_binary"] = kwargs["binary"]

`
    );

    replaceOnce(
      'build/tools/wpt/run.py',
      '    "android_webview": AndroidWebview,\n',
      '    "android_webview": AndroidWebview,\n    "duckduckgo": DuckDuckGoBrowser,\n'
    );

    replaceOnce(
      'build/tools/wptrunner/wptrunner/browsers/__init__.py',
      'product_list = ["android_webview",\n',
      'product_list = ["android_webview",\n                "duckduckgo",\n'
    );

    writeFileSync(
      'build/tools/wptrunner/wptrunner/browsers/duckduckgo.py',
      `# mypy: allow-untyped-defs

from .base import (WebDriverBrowser,  # noqa: F401
                   get_timeout_multiplier,  # noqa: F401
                   require_arg)
from ..executors import executor_kwargs as base_executor_kwargs
from ..executors.base import WdspecExecutor  # noqa: F401
from ..executors.executorwebdriver import (WebDriverTestharnessExecutor,  # noqa: F401
                                           WebDriverRefTestExecutor,  # noqa: F401
                                           WebDriverCrashtestExecutor)  # noqa: F401

__wptrunner__ = {
    "product": "duckduckgo",
    "check_args": "check_args",
    "browser": "DuckDuckGoBrowser",
    "browser_kwargs": "browser_kwargs",
    "executor_kwargs": "executor_kwargs",
    "env_options": "env_options",
    "env_extras": "env_extras",
    "timeout_multiplier": "get_timeout_multiplier",
    "executor": {
        "testharness": "WebDriverTestharnessExecutor",
        "reftest": "WebDriverRefTestExecutor",
        "wdspec": "WdspecExecutor",
        "crashtest": "WebDriverCrashtestExecutor"
    }
}

def check_args(**kwargs):
    require_arg(kwargs, "webdriver_binary")


def browser_kwargs(logger, test_type, run_info_data, config, **kwargs):
    return {"binary": kwargs["binary"],
            "webdriver_binary": kwargs["webdriver_binary"],
            "webdriver_args": kwargs.get("webdriver_args")}


def executor_kwargs(logger, test_type, test_environment, run_info_data,
                    **kwargs):
    executor_kwargs = base_executor_kwargs(test_type, test_environment, run_info_data, **kwargs)
    executor_kwargs["capabilities"] = {}
    return executor_kwargs


def env_options():
    return {}


def env_extras(**kwargs):
    return []


class DuckDuckGoBrowser(WebDriverBrowser):
    def make_command(self):
        return [self.webdriver_binary, "--port", str(self.port)] + self.webdriver_args
`
    );

    const patchFile = '../full.patch';
    if (existsSync(patchFile) && readFileSync(patchFile, 'utf8').trim().length > 0) {
      execSync(`patch -p1 < ${patchFile}`, { cwd: 'build' });
    }
}

function insertBefore(path, anchor, insertion) {
    const contents = readFileSync(path, 'utf8');
    if (contents.includes(insertion.trim())) {
      return;
    }
    if (!contents.includes(anchor)) {
      throw new Error(`Anchor not found in ${path}: ${anchor}`);
    }
    writeFileSync(path, contents.replace(anchor, `${insertion}\n${anchor}`));
}

function replaceOnce(path, searchValue, replacementValue) {
    const contents = readFileSync(path, 'utf8');
    if (contents.includes(replacementValue.trim())) {
      return;
    }
    if (!contents.includes(searchValue)) {
      throw new Error(`Search value not found in ${path}: ${searchValue}`);
    }
    writeFileSync(path, contents.replace(searchValue, replacementValue));
}
