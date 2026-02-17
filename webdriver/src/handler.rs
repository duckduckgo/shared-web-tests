use urlencoding;
use webdriver::server::{Session, WebDriverHandler};
use webdriver::httpapi::WebDriverExtensionRoute;
use webdriver::Parameters;
use webdriver::command::{WebDriverCommand, WebDriverExtensionCommand, WebDriverMessage};
use webdriver::error::WebDriverResult;
use webdriver::server::SessionTeardownKind;
use serde_json::{Map, Value};
use webdriver::command::WebDriverCommand::{
    CloseWindow, DeleteSession,
    ElementClear, ElementClick, ElementSendKeys, ExecuteAsyncScript, ExecuteScript,
    FindElement, FindElements,
    Get, GetCurrentUrl, GetElementAttribute,
    GetElementText,
    GetTitle, GetWindowHandle, GetWindowHandles,
    IsDisplayed,
    NewWindow, PerformActions, ReleaseActions,
    Status,
    SwitchToWindow, TakeElementScreenshot, TakeScreenshot,
};
use webdriver::response::{
    NewSessionResponse,
    NewWindowResponse, ValueResponse, WebDriverResponse,
};
use std::collections::HashMap;
use std::io::{BufReader, BufRead};
use std::thread;
use std::env;
use std::path::PathBuf;
use std::process::Command;
use uuid::Uuid;

use crate::platform::{Platform, DdgCapabilities};
use crate::server;
use crate::macos;
use crate::ios;

// --- WebDriver Extension Types ---

 #[derive(Clone, PartialEq, Eq, Debug)]
 pub enum DuckDuckGoExtensionRoute {
     GetContext
 }

 impl WebDriverExtensionRoute for DuckDuckGoExtensionRoute {
    type Command = DuckDuckGoExtensionCommand;

    fn command(
        &self,
        _params: &Parameters,
        _body_data: &Value,
    ) -> WebDriverResult<WebDriverCommand<DuckDuckGoExtensionCommand>> {
        use self::DuckDuckGoExtensionRoute::*;

        let command = match *self {
            GetContext => DuckDuckGoExtensionCommand::GetContext
        };

        Ok(WebDriverCommand::Extension(command))
    }
}

#[derive(Clone, Debug)]
pub enum DuckDuckGoExtensionCommand {
    GetContext
}

impl WebDriverExtensionCommand for DuckDuckGoExtensionCommand {
    fn parameters_json(&self) -> Option<Value> {
        use self::DuckDuckGoExtensionCommand::*;
        match self {
            GetContext => None
        }
    }
}

// --- Handler ---

#[derive(Default)]
pub(crate) struct Handler {
}

impl Handler {
    pub fn new() -> Self {
        Handler {}
    }
}

// --- WebDriver Command Handler ---

 impl WebDriverHandler<DuckDuckGoExtensionRoute> for Handler {
     fn handle_command(
         &mut self,
         _: &Option<Session>,
         msg: WebDriverMessage<DuckDuckGoExtensionRoute>,
     ) -> WebDriverResult<WebDriverResponse> {

        let platform = Platform::from_env();
        info!("Target platform: {:?}", platform);

        let target_device = if let Ok(env_path) = env::var("TARGET_DEVICE") {
            env_path
        } else {
            "iPhone-16".to_string()
        };
        let target_os = if let Ok(env_path) = env::var("TARGET_OS") {
            env_path
        } else {
            "iOS-18-2".to_string()
        };

        info!("Message received {:?}", msg);
        return match msg.command {
            WebDriverCommand::NewSession(ref params) => {
                let ddg_caps = DdgCapabilities::from_new_session_params(params);

                match platform {
                    Platform::MacOS => {
                        info!("Starting macOS automation...");

                        let session_id = Uuid::new_v4().to_string();

                        let app_path = if let Ok(env_path) = env::var("MACOS_APP_PATH") {
                            env_path
                        } else {
                            let derived_data_path = if let Ok(env_path) = env::var("DERIVED_DATA_PATH") {
                                PathBuf::from(env_path)
                            } else {
                                let current_dir = env::current_dir().expect("Failed to get current directory");
                                current_dir.join("../ddg-workflow/apple-browsers/DerivedData")
                            };
                            format!("{}/Build/Products/Debug/DuckDuckGo.app", derived_data_path.to_str().expect("Failed to convert path to string"))
                        };

                        info!("macOS App Path: {:?}", app_path);

                        let port = server::get_port(&session_id);

                        let bundle_id = match macos::launch_app(&app_path, port, &ddg_caps) {
                            Ok((_, bundle_id)) => {
                                info!("Launched macOS app");
                                bundle_id
                            },
                            Err(e) => {
                                info!("Failed to launch macOS app: {}", e);
                                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                            }
                        };

                        // Start monitoring logs
                        let mut child = macos::monitor_logs(&bundle_id);
                        let stdout = child.stdout.take().expect("Failed to capture stdout");
                        thread::spawn(move || {
                            let reader = BufReader::new(stdout);
                            info!("macOS app logs:");
                            for line in reader.lines() {
                                if let Ok(log_line) = line {
                                    info!("{}", log_line);
                                }
                            }
                            info!("macOS app logs end");
                        });

                        // Wait for the server to start
                        info!("Waiting for automation server on port {}...", port);
                        let mut attempts = 0;
                        loop {
                            let client = reqwest::blocking::Client::builder()
                                .timeout(std::time::Duration::from_millis(500))
                                .build()
                                .expect("Failed to create client");
                            match client.get(format!("http://localhost:{}/getUrl", port)).send() {
                                Ok(_) => {
                                    info!("Server responding on port {}", port);
                                    break;
                                }
                                Err(_) => {}
                            }
                            attempts += 1;
                            if attempts > 120 {
                                panic!("Timeout waiting for automation server to start");
                            }
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }

                        // Wait for content blocker rules to be compiled
                        info!("Waiting for content blocker to be ready...");
                        let cb_start = std::time::Instant::now();
                        let mut cb_attempts = 0;
                        loop {
                            let client = reqwest::blocking::Client::builder()
                                .timeout(std::time::Duration::from_millis(500))
                                .build()
                                .expect("Failed to create client");
                            match client.get(format!("http://localhost:{}/contentBlockerReady", port)).send() {
                                Ok(response) => {
                                    if let Ok(text) = response.text() {
                                        if let Ok(json) = serde_json::from_str::<Value>(&text) {
                                            if let Some(message) = json.get("message").and_then(|v| v.as_str()) {
                                                if message == "true" {
                                                    let elapsed = cb_start.elapsed();
                                                    info!("Content blocker ready after {:?} ({} attempts)", elapsed, cb_attempts + 1);
                                                    break;
                                                }
                                            }
                                            info!("Content blocker not ready yet (attempt {}, message: {:?})", cb_attempts + 1, json.get("message"));
                                        } else {
                                            info!("Content blocker check: failed to parse JSON (attempt {}): {}", cb_attempts + 1, text);
                                        }
                                    }
                                }
                                Err(e) => {
                                    info!("Content blocker check failed (attempt {}): {}", cb_attempts + 1, e);
                                }
                            }
                            cb_attempts += 1;
                            if cb_attempts > 60 {
                                info!("Warning: Timeout waiting for content blocker after {:?}, proceeding anyway", cb_start.elapsed());
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }

                        let _ = child.kill();
                        let capabilities = Map::new();
                        Ok(WebDriverResponse::NewSession(NewSessionResponse {
                            session_id: session_id,
                            capabilities: Value::Object(capabilities),
                        }))
                    },
                    Platform::IOS => {
                        info!("Starting iOS automation... {:?} {:?}", target_device, target_os);
                        let simulator_udid = match ios::find_or_create_simulator(&target_device, &target_os) {
                            Ok(udid) => udid,
                            Err(e) => {
                                info!("Failed to find or create simulator: {}", e);
                                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                            }
                        };
                        info!("Simulator UDID: {:?}", simulator_udid);

                        ios::xcrun_command(&["simctl", "boot", &simulator_udid]);

                        Command::new("open")
                            .args(&["-a", "Simulator"])
                            .status()
                            .expect("Failed to open the Simulator app");
                        info!("Opened Simulator app");
                        ios::xcrun_command(&["simctl", "terminate", &simulator_udid, ios::BUNDLE_ID]);
                        ios::xcrun_command(&["simctl", "uninstall", &simulator_udid, ios::BUNDLE_ID]);
                        info!("Uninstalled app");

                        let derived_data_path = if let Ok(env_path) = env::var("DERIVED_DATA_PATH") {
                            PathBuf::from(env_path)
                        } else {
                            let current_dir = env::current_dir().expect("Failed to get current directory");
                            current_dir.join("../DerivedData")
                        };
                        let derived_data_path = derived_data_path.to_str().expect("Failed to convert path to string");
                        let app_path = format!("{derived_data_path}/Build/Products/Debug-iphonesimulator/DuckDuckGo.app");
                        info!("App Path: {:?}", app_path);
                        if !ios::xcrun_command(&["simctl", "install", &simulator_udid, app_path.as_str()]).status.success() {
                            panic!("Failed to install the app");
                        }
                        info!("Installed app");

                        let mut child = ios::monitor_simulator_logs(&simulator_udid);
                        let stdout = child.stdout.take().expect("Failed to capture stdout");
                        thread::spawn(move || {
                            let reader = BufReader::new(stdout);
                            info!("Simulator logs:");
                            for line in reader.lines() {
                                if let Ok(log_line) = line {
                                    info!("{}", log_line);
                                }
                            }
                            info!("Simulator logs end");
                        });

                        let logger = ios::xcrun_command(&[
                            "simctl", "spawn", &simulator_udid, "log", "config",
                            "--mode", "level:debug", "-subsystem", ios::BUNDLE_ID
                        ]);
                        if !logger.status.success() {
                            panic!("Failed to set log level\n{}", String::from_utf8_lossy(&logger.stderr));
                        }

                        let persist_logs = ios::xcrun_command(&[
                            "simctl", "spawn", &simulator_udid, "log", "config",
                            "--mode", "persist:debug", "-subsystem", ios::BUNDLE_ID
                        ]);
                        if !persist_logs.status.success() {
                            panic!("Failed to perist log level\n{}", String::from_utf8_lossy(&persist_logs.stderr));
                        }

                        ios::write_defaults(&simulator_udid, "isUITesting", "bool", "true");
                        ios::write_defaults(&simulator_udid, "isOnboardingCompleted", "string", "true");
                        let port = server::get_port(&simulator_udid);
                        ios::write_defaults(&simulator_udid, "automationPort", "int", port.to_string().as_str());

                        if let Some(ref config_url) = ddg_caps.privacy_config_url {
                            ios::setup_privacy_config(&simulator_udid, config_url);
                        }

                        if !ios::xcrun_command(&[
                                "simctl", "launch", &simulator_udid, ios::BUNDLE_ID,
                                "isUITesting", "true"
                            ]).status.success() {
                            panic!("Failed to launch the app");
                        }

                        // Wait for the server to start
                        loop {
                            if !server::port_is_available_check(port) {
                                break;
                            }
                        }

                        // Wait for content blocker rules to be compiled
                        info!("Waiting for content blocker to be ready (iOS)...");
                        let cb_start = std::time::Instant::now();
                        let mut cb_attempts = 0;
                        loop {
                            let client = reqwest::blocking::Client::builder()
                                .timeout(std::time::Duration::from_millis(500))
                                .build()
                                .expect("Failed to create client");
                            match client.get(format!("http://localhost:{}/contentBlockerReady", port)).send() {
                                Ok(response) => {
                                    if let Ok(text) = response.text() {
                                        if let Ok(json) = serde_json::from_str::<Value>(&text) {
                                            if let Some(message) = json.get("message").and_then(|v| v.as_str()) {
                                                if message == "true" {
                                                    let elapsed = cb_start.elapsed();
                                                    info!("Content blocker ready (iOS) after {:?} ({} attempts)", elapsed, cb_attempts + 1);
                                                    break;
                                                }
                                            }
                                            info!("Content blocker not ready yet (iOS, attempt {}, message: {:?})", cb_attempts + 1, json.get("message"));
                                        } else {
                                            info!("Content blocker check (iOS): failed to parse JSON (attempt {}): {}", cb_attempts + 1, text);
                                        }
                                    }
                                }
                                Err(e) => {
                                    info!("Content blocker check failed (iOS, attempt {}): {}", cb_attempts + 1, e);
                                }
                            }
                            cb_attempts += 1;
                            if cb_attempts > 60 {
                                info!("Warning: Timeout waiting for content blocker (iOS) after {:?}, proceeding anyway", cb_start.elapsed());
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }

                        let _ = child.kill();
                        let capabilities = Map::new();
                        Ok(WebDriverResponse::NewSession(NewSessionResponse {
                            session_id: simulator_udid.to_string(),
                            capabilities: Value::Object(capabilities),
                        }))
                    }
                }
            },
            DeleteSession => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                info!("Deleting session {:?}", session_id);
                match platform {
                    Platform::MacOS => {
                        let port = server::get_port(session_id);
                        macos::quit_app_with_port(Some(port));
                    },
                    Platform::IOS => {
                        ios::xcrun_command(&["simctl", "shutdown", session_id]);
                    }
                }
                Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
            },
            Status => {
                let status = serde_json::json!({
                    "ready": true,
                    "message": "DuckDuckGo WebDriver ready"
                });
                Ok(WebDriverResponse::Generic(ValueResponse(status)))
            },
            Get(params) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let url = params.url.as_str();
                let mut params = HashMap::new();
                params.insert("url", url);
                server::server_request_for_platform(session_id, &platform, "navigate", &params);
                return Ok(WebDriverResponse::Void);
            },
            ExecuteScript(params) => {
                let script = params.script.as_str();
                info!("Script: {:#?}", params);
                let script_args = params.args.as_ref().expect("Expected args");
                let script_args_str = script_args
                .iter()
                .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                .collect::<Vec<_>>();

                let script_args_str = script_args_str.join(", ");

                let script_wrapper = r#"
                  return (function () {
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

                    const rawArgs = [__SCRIPT_ARGS__];
                    const resolvedArgs = resolveElementRefs(rawArgs);

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
                        uuid = window.crypto.randomUUID();
                        window.__webdriver_script_results.set(result, uuid);
                      }
                      const elementRef = {};
                      elementRef[ELEMENT_KEY] = uuid;
                      return elementRef;
                    }
                    return result;
                  }());
                "#;
                let script = script_wrapper.replace("__SCRIPT__", script).replace("__SCRIPT_ARGS__", script_args_str.as_str());
                let mut params = HashMap::new();
                let script = urlencoding::encode(&script).to_string();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &params);

                if let Ok(json_value) = serde_json::from_str::<Value>(&response) {
                    if let Some(element_id) = json_value.get(webdriver::common::ELEMENT_KEY).and_then(|v| v.as_str()) {
                        let mut res = Map::new();
                        res.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(element_id.to_string()));
                        return Ok(WebDriverResponse::Generic(ValueResponse(res.into())));
                    }
                    return Ok(WebDriverResponse::Generic(ValueResponse(json_value)));
                }

                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(response))));
            },
            ExecuteAsyncScript(params) => {
                let script = params.script.as_str();
                info!("Script: {:#?}", params);
                let script_args = params.args.as_ref().expect("Expected args");
                let mut script_args_str = script_args
                .iter()
                .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                .collect::<Vec<_>>();

                script_args_str.push("res".to_string());
                let script_args_str = script_args_str.join(", ");

                let script_wrapper = r#"
                let promiseResult = new Promise((res, rej) => {
                  const timeout = setTimeout(() => {
                    rej("Script execution timed out");
                  }, 15000);

                  (async function asyncMethod () {
                    __SCRIPT__
                  }(__SCRIPT_ARGS__)).then(result => {
                    clearTimeout(timeout);
                    res(result);
                  }).catch(error => {
                    clearTimeout(timeout);
                    rej(error);
                  });
                });
                return promiseResult;
                "#;
                let script = script_wrapper.replace("__SCRIPT__", script).replace("__SCRIPT_ARGS__", script_args_str.as_str());
                let mut params = HashMap::new();
                let script = urlencoding::encode(&script).to_string();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &params);
                info!("Script Response: {:#?}", response);
                let parsed: Value = serde_json::from_str(&response)?;
                return Ok(WebDriverResponse::Generic(ValueResponse(parsed.into())));
            },
            FindElement(params) => {
                let script = include_str!("find-element.js");
                let script = urlencoding::encode(&script).to_string();
                let mut url_params = HashMap::new();
                url_params.insert("script", script.as_str());
                let json_string = serde_json::to_string(&params).unwrap();
                let json_string = urlencoding::encode(&json_string).to_string();
                url_params.insert("args", json_string.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &url_params);
                let response_clone = response.clone();
                let element_id = if let Ok(parsed) = serde_json::from_str::<Value>(&response) {
                    parsed.as_str().unwrap_or(&response).to_string()
                } else {
                    response
                };
                info!("FindElement response: {:?}, element_id: {:?}", response_clone, element_id);
                let mut res = Map::new();
                res.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(element_id));
                return Ok(WebDriverResponse::Generic(ValueResponse(res.into())));
            },
            FindElements(params) => {
                let script = include_str!("find-elements.js");
                let script = urlencoding::encode(&script).to_string();
                let mut url_params = HashMap::new();
                url_params.insert("script", script.as_str());
                let json_string = serde_json::to_string(&params).unwrap();
                let json_string = urlencoding::encode(&json_string).to_string();
                url_params.insert("args", json_string.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &url_params);
                info!("FindElements raw response: {:?} (length: {})", response, response.len());
                let element_ids_array: Value = match serde_json::from_str::<Value>(&response) {
                    Ok(arr @ Value::Array(_)) => {
                        info!("FindElements: Parsed as array directly ({} elements)", arr.as_array().unwrap().len());
                        arr
                    }
                    Ok(Value::String(s)) => {
                        info!("FindElements: Parsed as JSON string, trying to parse inner string: {:?}", s);
                        serde_json::from_str::<Value>(&s).unwrap_or_else(|e| {
                            error!("FindElements: Failed to parse inner JSON string: {} (string: {:?})", e, s);
                            Value::Array(Vec::new())
                        })
                    }
                    Ok(error_obj @ Value::Object(_)) => {
                        info!("FindElements: Parsed as object: {:?}", error_obj);
                        if let Some(error_msg) = error_obj.get("error").and_then(|v| v.as_str()) {
                            error!("FindElements script execution failed: {}", error_msg);
                            return Ok(WebDriverResponse::Generic(ValueResponse(Value::Array(Vec::new()))));
                        }
                        Value::Array(Vec::new())
                    }
                    Ok(other) => {
                        error!("FindElements: Unexpected response format: {:?}", other);
                        Value::Array(Vec::new())
                    }
                    Err(e) => {
                        error!("FindElements: Failed to parse response as JSON: {} (response: {:?})", e, response);
                        Value::Array(Vec::new())
                    }
                };
                info!("FindElements: Parsed array type: {:?}, is_array: {}, array_len: {:?}",
                    element_ids_array,
                    element_ids_array.is_array(),
                    element_ids_array.as_array().map(|a| a.len()));
                let element_ids: Vec<String> = element_ids_array
                    .as_array()
                    .unwrap_or(&Vec::new())
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                info!("FindElements response: {:?}, element_ids: {:?}", response, element_ids);
                let elements: Vec<Value> = element_ids
                    .into_iter()
                    .map(|id| {
                        let mut elem = Map::new();
                        elem.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(id));
                        Value::Object(elem)
                    })
                    .collect();
                return Ok(WebDriverResponse::Generic(ValueResponse(elements.into())));
            },
            ElementClick(element_ref) => {
                let script_body = r#"
                let element;
                if (!window.__webdriver_script_results) {
                    throw new Error('No elements found');
                }
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        element = el;
                        break;
                    }
                }
                if (!element) {
                    throw new Error('Element not found');
                }
                element.click();
                return "clicked";
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                server::server_request_for_platform(session_id, &platform, "execute", &params);
                return Ok(WebDriverResponse::Void);
            },
            GetElementText(element_ref) => {
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    return '';
                }
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        return el.textContent || el.innerText || '';
                    }
                }
                return '';
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &params);
                let text = serde_json::from_str::<Value>(&response)
                    .ok()
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or(response);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(text))));
            },
            GetElementAttribute(element_ref, attr_name) => {
                info!("GetElementAttribute called: element={}, attr={}", element_ref, attr_name);
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    return null;
                }
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        return el.getAttribute(attrName);
                    }
                }
                return null;
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    format!("let attrName = '{}';", &attr_name),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &params);
                if response == "null" || response.is_empty() {
                    return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                }
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(response))));
            },
            IsDisplayed(element_ref) => {
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    return false;
                }
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        return style.display !== 'none' &&
                               style.visibility !== 'hidden' &&
                               style.opacity !== '0' &&
                               rect.width > 0 &&
                               rect.height > 0;
                    }
                }
                return false;
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &params);
                let is_displayed = response == "true" || response == "1";
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Bool(is_displayed))));
            },
            ElementSendKeys(element_ref, keys) => {
                info!("ElementSendKeys called: element={}, keys={:?}", element_ref, keys);
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    throw new Error('No elements found');
                }
                let element;
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        element = el;
                        break;
                    }
                }
                if (!element) {
                    throw new Error('Element not found: ' + elementId);
                }
                element.focus();
                if ('value' in element) {
                    element.value = textToSend;
                } else if (element.isContentEditable) {
                    element.textContent = textToSend;
                }
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                return 'sent';
                "#;
                let text = keys.text.as_str();
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    format!("let textToSend = {};", serde_json::to_string(text).unwrap()),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &params);
                info!("ElementSendKeys response: {:?}", response);
                return Ok(WebDriverResponse::Void);
            },
            ElementClear(element_ref) => {
                info!("ElementClear called: element={}", element_ref);
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    throw new Error('No elements found');
                }
                let element;
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        element = el;
                        break;
                    }
                }
                if (!element) {
                    throw new Error('Element not found: ' + elementId);
                }
                element.focus();
                if ('value' in element) {
                    element.value = '';
                } else if (element.isContentEditable) {
                    element.textContent = '';
                }
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                return 'cleared';
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &params);
                info!("ElementClear response: {:?}", response);
                return Ok(WebDriverResponse::Void);
            },
            GetTitle => {
                let script = "return document.title || '';";
                let script = urlencoding::encode(script).to_string();
                let mut params = HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "execute", &params);
                let title = serde_json::from_str::<Value>(&response)
                    .ok()
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or_default();
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(title))));
            },
            NewWindow(_) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = server::server_request_for_platform(session_id, &platform, "newWindow", &HashMap::new());
                info!("New window handle: {:#?}", window_handle);
                #[derive(Deserialize, Debug)]
                struct ResponseNewWindow {
                    handle: String,
                    r#type: String
                }
                let response: ResponseNewWindow = serde_json::from_str(&window_handle).expect("Failed to parse window handles");
                info!("Window handle json: {:#?}", response);
                return Ok(WebDriverResponse::NewWindow(NewWindowResponse {
                    handle: response.handle,
                    typ: response.r#type,
                }));
            },
            CloseWindow => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = server::server_request_for_platform(session_id, &platform, "closeWindow", &HashMap::new());
                info!("Close window handle: {:#?}", window_handle);

                let window_handles = server::server_request_for_platform(session_id, &platform, "getWindowHandles", &HashMap::new());
                let window_handles: Vec<String> = serde_json::from_str(&window_handles).expect("Failed to parse window handles");
                info!("Window handles: {:#?}", window_handles);
                return Ok(WebDriverResponse::Generic(ValueResponse(window_handles.into())));
            },
            SwitchToWindow(params_in) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let mut params = HashMap::new();
                params.insert("handle", params_in.handle.as_str());
                server::server_request_for_platform(session_id, &platform, "switchToWindow", &params);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
            },
            GetWindowHandle => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = server::server_request_for_platform(session_id, &platform, "getWindowHandle", &HashMap::new());
                info!("Window handle: {:#?}", window_handle);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(window_handle))));
            },
            GetWindowHandles => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handles = server::server_request_for_platform(session_id, &platform, "getWindowHandles", &HashMap::new());
                let window_handles: Vec<String> = serde_json::from_str(&window_handles).expect("Failed to parse window handles");
                info!("Window handles: {:#?}", window_handles);
                return Ok(WebDriverResponse::Generic(ValueResponse(window_handles.into())));
            },
            GetCurrentUrl => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                info!("Session {:?}", session_id);
                let url_string = server::server_request_for_platform(session_id, &platform, "getUrl", &HashMap::new());
                info!("UrlString response: {:#?}", url_string);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(url_string))));
            },
            ReleaseActions | PerformActions(_) => {
                info!("Actions command - no-op, returning void");
                return Ok(WebDriverResponse::Void);
            },
            TakeScreenshot => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server::server_request_for_platform(session_id, &platform, "screenshot", &HashMap::new());
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(response))));
            },
            TakeElementScreenshot(element_ref) => {
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    return null;
                }
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        const rect = el.getBoundingClientRect();
                        return JSON.stringify({
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        });
                    }
                }
                return null;
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let rect_response = server::server_request_for_platform(session_id, &platform, "execute", &params);

                let mut screenshot_params = HashMap::new();
                screenshot_params.insert("rect", rect_response.as_str());
                let response = server::server_request_for_platform(session_id, &platform, "screenshot", &screenshot_params);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(response))));
            },
            _ => {
                info!("Unhandled command: {:?}", msg.command);
                Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
            },
        };
     }

    fn teardown_session(&mut self, kind: SessionTeardownKind) {
       info!("Tearing down session (kind: {:?})", kind);

       let platform = Platform::from_env();
       match platform {
           Platform::MacOS => {
               if matches!(kind, SessionTeardownKind::Deleted) {
                   macos::quit_app_with_port(None);
               }
           },
           Platform::IOS => {
               // iOS cleanup handled by DeleteSession command
           }
       }
    }
}
