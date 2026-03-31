use super::Platform;
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::str;
use std::sync::{Mutex, OnceLock};
use std::thread;

const APP_BUNDLE_ID: &str = "com.duckduckgo.mobile.ios";

pub struct IosPlatform {
    target_device: String,
    target_os: String,
}

impl IosPlatform {
    pub fn new() -> Self {
        let target_device = env::var("TARGET_DEVICE").unwrap_or_else(|_| "iPhone-16".to_string());
        let target_os = env::var("TARGET_OS").unwrap_or_else(|_| "iOS-18-2".to_string());
        IosPlatform {
            target_device,
            target_os,
        }
    }
}

struct PortManager {
    ports: Mutex<HashMap<&'static str, u16>>,
}

impl PortManager {
    fn new() -> Self {
        PortManager {
            ports: Mutex::new(HashMap::new()),
        }
    }

    fn get_port(&self, udid: &str) -> u16 {
        let mut ports = self.ports.lock().unwrap();
        if let Some(&port) = ports.get(udid) {
            return port;
        }

        for port in 8557..=65535 {
            if port_is_available(port) {
                ports.insert(Box::leak(udid.to_string().into_boxed_str()), port);
                return port;
            }
        }
        panic!("No available ports found");
    }
}

fn port_is_available(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_ok()
}

static PORT_MANAGER: OnceLock<PortManager> = OnceLock::new();

fn get_port(udid: &str) -> u16 {
    let port_manager = PORT_MANAGER.get_or_init(PortManager::new);
    port_manager.get_port(udid)
}

fn server_request(
    udid: &str,
    method: &str,
    params: &HashMap<&str, &str>,
) -> String {
    let mut child = monitor_simulator_logs(udid);
    let port = get_port(udid);
    let query_string: String = params
        .iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect::<Vec<String>>()
        .join("&");
    let url = format!("http://localhost:{}/{method}?{}", port, query_string);
    info!("URL to send: {:?}", url);
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .map_err(|e| {
            if e.is_timeout() {
                info!("Request timed out");
                "Request timed out".to_string()
            } else {
                "Other error".to_string()
            }
        })
        .expect("Failed to send request")
        .text()
        .expect("Failed to read response text");
    info!("Response: {:#?}", resp);
    #[derive(serde::Deserialize)]
    struct Response {
        message: String,
    }
    let json: Response = serde_json::from_str(&resp).expect("Failed to parse response");
    let _ = child.kill();
    json.message
}

fn find_or_create_simulator(target_device: &str, target_os: &str) -> Result<String, String> {
    let list_output = xcrun_command(&["simctl", "list", "devices", "-j"]);
    let device_name = format!("{target_device} {target_os} (webdriver)");

    let list_stdout =
        str::from_utf8(&list_output.stdout).expect("Invalid UTF-8 in simulator list");
    let simulators: serde_json::Value =
        serde_json::from_str(list_stdout).expect("Failed to parse simulator list");

    if let Some(devices) = simulators.get("devices") {
        for (runtime, device_list) in devices.as_object().unwrap() {
            info!("Runtime: {:?}", runtime);
            if runtime.contains(target_os) {
                for device in device_list.as_array().unwrap() {
                    if device["name"] == device_name
                        && device["isAvailable"] == true
                        && device["state"] == "Shutdown"
                    {
                        info!("Found matching simulator {:?}", device);
                        return Ok(device["udid"].as_str().unwrap().to_string());
                    }
                }
            }
        }
    }
    info!("No matching simulator found, creating a new one...");

    let create_output = xcrun_command(&[
        "simctl",
        "create",
        &device_name,
        &("com.apple.CoreSimulator.SimDeviceType.".to_owned() + target_device),
        &("com.apple.CoreSimulator.SimRuntime.".to_owned() + target_os),
    ]);

    let cargo_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path_to_ca_cert = cargo_path.join("cacert.pem");

    let _install_ca_key = xcrun_command(&[
        "simctl",
        "keychain",
        &device_name,
        "add-root-cert",
        path_to_ca_cert
            .to_str()
            .expect("Failed to convert path to string"),
    ]);

    if !create_output.status.success() {
        return Err("Failed to create a new simulator".to_string());
    }

    let new_udid = str::from_utf8(&create_output.stdout)
        .expect("Invalid UTF-8 in create simulator output")
        .trim();
    Ok(new_udid.to_string())
}

fn log_level() -> String {
    match log::max_level() {
        log::LevelFilter::Error => "error",
        log::LevelFilter::Warn => "warn",
        log::LevelFilter::Info => "info",
        log::LevelFilter::Debug => "debug",
        log::LevelFilter::Trace => "trace",
        log::LevelFilter::Off => "off",
    }
    .to_string()
}

fn monitor_simulator_logs(udid: &str) -> Child {
    let mut child = Command::new("xcrun")
        .args([
            "simctl",
            "spawn",
            udid,
            "log",
            "stream",
            "--level",
            &log_level(),
            "--predicate",
            &format!("subsystem == \"{}\"", APP_BUNDLE_ID),
        ])
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed to start tail process");

    let stdout = child.stdout.take().expect("Failed to capture stdout");
    thread::spawn(move || {
        info!("Simulator logs:");
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(log_line) = line {
                info!("Simulator: {}", log_line);
            }
        }
        info!("Simulator logs end");
    });

    child
}

fn xcrun_command(args: &[&str]) -> std::process::Output {
    let output = Command::new("xcrun")
        .args(args)
        .output()
        .expect("Failed to run xcrun command");
    if !output.status.success() {
        info!(
            "Failed to run xcrun command: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    output
}

fn write_defaults(udid: &str, key: &str, key_type: &str, value: &str) {
    xcrun_command(&[
        "simctl",
        "spawn",
        udid,
        "defaults",
        "write",
        APP_BUNDLE_ID,
        key,
        &format!("-{key_type}"),
        value,
    ]);
}

impl Platform for IosPlatform {
    fn new_session(&mut self) -> Result<String, String> {
        info!(
            "Starting iOS automation... {:?} {:?}",
            self.target_device, self.target_os
        );
        let simulator_udid = find_or_create_simulator(&self.target_device, &self.target_os)?;
        info!("Simulator UDID: {:?}", simulator_udid);

        xcrun_command(&["simctl", "boot", &simulator_udid]);

        Command::new("open")
            .args(["-a", "Simulator"])
            .status()
            .expect("Failed to open the Simulator app");
        info!("Opened Simulator app");
        xcrun_command(&["simctl", "terminate", &simulator_udid, APP_BUNDLE_ID]);
        xcrun_command(&["simctl", "uninstall", &simulator_udid, APP_BUNDLE_ID]);
        info!("Uninstalled app");

        let derived_data_path = if let Ok(env_path) = env::var("DERIVED_DATA_PATH") {
            PathBuf::from(env_path)
        } else {
            let current_dir = env::current_dir().expect("Failed to get current directory");
            current_dir.join("../DerivedData")
        };
        let derived_data_path = derived_data_path
            .to_str()
            .expect("Failed to convert path to string");
        let app_path = format!(
            "{derived_data_path}/Build/Products/Debug-iphonesimulator/DuckDuckGo.app"
        );
        info!("App Path: {:?}", app_path);
        if !xcrun_command(&["simctl", "install", &simulator_udid, app_path.as_str()])
            .status
            .success()
        {
            return Err("Failed to install the app".to_string());
        }
        info!("Installed app");
        let mut child = monitor_simulator_logs(&simulator_udid);
        let logger = xcrun_command(&[
            "simctl",
            "spawn",
            &simulator_udid,
            "log",
            "config",
            "--mode",
            &format!("level:{}", log_level()),
            "-subsystem",
            APP_BUNDLE_ID,
        ]);
        if !logger.status.success() {
            return Err(format!(
                "Failed to set log level\n{}",
                String::from_utf8_lossy(&logger.stderr)
            ));
        }

        let persist_logs = xcrun_command(&[
            "simctl",
            "spawn",
            &simulator_udid,
            "log",
            "config",
            "--mode",
            &format!("persist:{}", log_level()),
            "-subsystem",
            APP_BUNDLE_ID,
        ]);
        if !persist_logs.status.success() {
            return Err(format!(
                "Failed to persist log level\n{}",
                String::from_utf8_lossy(&persist_logs.stderr)
            ));
        }

        write_defaults(&simulator_udid, "isUITesting", "bool", "true");
        write_defaults(
            &simulator_udid,
            "isOnboardingCompleted",
            "string",
            "true",
        );
        let port = get_port(&simulator_udid);
        write_defaults(
            &simulator_udid,
            "automationPort",
            "int",
            port.to_string().as_str(),
        );

        if !xcrun_command(&[
            "simctl",
            "launch",
            &simulator_udid,
            APP_BUNDLE_ID,
            "isUITesting",
            "true",
        ])
        .status
        .success()
        {
            return Err("Failed to launch the app".to_string());
        }

        loop {
            if !port_is_available(port) {
                break;
            }
        }

        let _ = child.kill();
        Ok(simulator_udid)
    }

    fn delete_session(&mut self, session_id: &str) -> Result<(), String> {
        info!("Deleting iOS session {:?}", session_id);
        xcrun_command(&["simctl", "shutdown", session_id]);
        Ok(())
    }

    fn navigate(&self, session_id: &str, url: &str) -> Result<(), String> {
        let mut params = HashMap::new();
        params.insert("url", url);
        server_request(session_id, "navigate", &params);
        Ok(())
    }

    fn execute_script(
        &self,
        session_id: &str,
        script: &str,
        _args: &str,
    ) -> Result<String, String> {
        let mut params = HashMap::new();
        let encoded = urlencoding::encode(script).to_string();
        params.insert("script", encoded.as_str());
        Ok(server_request(session_id, "execute", &params))
    }

    fn execute_async_script(
        &self,
        session_id: &str,
        script: &str,
        _args: &str,
    ) -> Result<String, String> {
        let mut params = HashMap::new();
        let encoded = urlencoding::encode(script).to_string();
        params.insert("script", encoded.as_str());
        Ok(server_request(session_id, "execute", &params))
    }

    fn find_element(
        &self,
        session_id: &str,
        script: &str,
        args: &str,
    ) -> Result<String, String> {
        let encoded_script = urlencoding::encode(script).to_string();
        let encoded_args = urlencoding::encode(args).to_string();
        let mut params = HashMap::new();
        params.insert("script", encoded_script.as_str());
        params.insert("args", encoded_args.as_str());
        Ok(server_request(session_id, "execute", &params))
    }

    fn click_element(&self, session_id: &str, element_id: &str) -> Result<(), String> {
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
        let script = format!("let elementId = '{}'; {}", element_id, script_body);
        let encoded = urlencoding::encode(&script).to_string();
        let mut params = HashMap::new();
        params.insert("script", encoded.as_str());
        server_request(session_id, "execute", &params);
        Ok(())
    }

    fn new_window(&self, session_id: &str) -> Result<(String, String), String> {
        let response = server_request(session_id, "newWindow", &HashMap::new());
        #[derive(serde::Deserialize, Debug)]
        struct ResponseNewWindow {
            handle: String,
            r#type: String,
        }
        let parsed: ResponseNewWindow =
            serde_json::from_str(&response).map_err(|e| e.to_string())?;
        Ok((parsed.handle, parsed.r#type))
    }

    fn close_window(&self, session_id: &str) -> Result<Vec<String>, String> {
        server_request(session_id, "closeWindow", &HashMap::new());
        let handles_str = server_request(session_id, "getWindowHandles", &HashMap::new());
        serde_json::from_str(&handles_str).map_err(|e| e.to_string())
    }

    fn switch_to_window(&self, session_id: &str, handle: &str) -> Result<(), String> {
        let mut params = HashMap::new();
        params.insert("handle", handle);
        server_request(session_id, "switchToWindow", &params);
        Ok(())
    }

    fn get_window_handle(&self, session_id: &str) -> Result<String, String> {
        Ok(server_request(
            session_id,
            "getWindowHandle",
            &HashMap::new(),
        ))
    }

    fn get_window_handles(&self, session_id: &str) -> Result<Vec<String>, String> {
        let handles_str = server_request(session_id, "getWindowHandles", &HashMap::new());
        serde_json::from_str(&handles_str).map_err(|e| e.to_string())
    }

    fn get_current_url(&self, session_id: &str) -> Result<String, String> {
        Ok(server_request(session_id, "getUrl", &HashMap::new()))
    }
}
