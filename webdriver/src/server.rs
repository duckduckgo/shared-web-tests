use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::io::{BufReader, BufRead};
use std::thread;

use crate::platform::Platform;
use crate::ios;
use crate::macos;

struct PortManager {
    ports: Mutex<HashMap<String, u16>>,
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
                ports.insert(udid.to_string(), port);
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

pub(crate) fn get_port(udid: &str) -> u16 {
    let port_manager = PORT_MANAGER.get_or_init(PortManager::new);
    port_manager.get_port(udid)
}

pub(crate) fn port_is_available_check(port: u16) -> bool {
    port_is_available(port)
}

pub(crate) fn server_request_for_platform(session_id: &str, platform: &Platform, method: &str, params: &HashMap<&str, &str>) -> String {
    match platform {
        Platform::IOS => {
            let mut child = ios::monitor_simulator_logs(session_id);
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
            let port = get_port(session_id);
            let result = make_server_request(port, method, params);
            let _ = child.kill();
            result
        },
        Platform::MacOS => {
            let mut child = macos::monitor_logs(macos::BUNDLE_ID);
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
            let port = get_port(session_id);
            let result = make_server_request(port, method, params);
            let _ = child.kill();
            result
        }
    }
}

fn make_server_request(port: u16, method: &str, params: &HashMap<&str, &str>) -> String {
    let query_string: String = params.iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect::<Vec<String>>()
        .join("&");
    let url = format!("http://localhost:{}/{method}?{}", port, query_string);
    info!("URL to send: {:?}", url);
    let client = reqwest::blocking::Client::new();
    let resp = client.get(url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .map_err(|e| {
            if e.is_timeout() {
                info!("Request timed out");
                "Request timed out".to_string()
            } else {
                format!("Request error: {}", e)
            }
        })
        .expect("Failed to send request")
        .text()
        .expect("Failed to read response text");
    info!("Response: {:#?}", resp);

    #[derive(Deserialize)]
    struct Response {
        message: String,
    }
    let json: Response = serde_json::from_str(&resp).expect("Failed to parse response");
    json.message
}
