use std::collections::HashMap;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;

const BROWSER_EXECUTABLE: &str = "DuckDuckGo.exe";

/// Manages Windows browser sessions
pub struct WindowsSessionManager {
    sessions: Mutex<HashMap<String, WindowsSession>>,
}

impl WindowsSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(&self) -> Result<(String, u16), String> {
        let debug_port = find_available_port(9222);
        let session = WindowsSession::new(debug_port)?;
        let session_id = session.session_id.clone();
        let port = session.debug_port;

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), session);

        Ok((session_id, port))
    }

    pub fn get_port(&self, session_id: &str) -> Option<u16> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .map(|s| s.debug_port)
    }

    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(session_id) {
            session.close();
            Ok(())
        } else {
            Err(format!("Session {} not found", session_id))
        }
    }
}

impl Default for WindowsSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

pub struct WindowsSession {
    session_id: String,
    debug_port: u16,
    process: Child,
}

impl WindowsSession {
    pub fn new(debug_port: u16) -> Result<Self, String> {
        let browser_path = std::env::var("DDG_BROWSER_PATH").unwrap_or_else(|_| BROWSER_EXECUTABLE.to_string());

        info!("Launching Windows browser at: {}", browser_path);
        info!("Debug port: {}", debug_port);

        let process = Command::new(&browser_path)
            .env("DDG_WEBVIEW_DEBUG_PORT", debug_port.to_string())
            .env("DDG_ISDEBUGGING", "true")
            .spawn()
            .map_err(|e| format!("Failed to launch browser '{}': {}", browser_path, e))?;

        let session_id = format!("windows-{}", process.id());

        info!("Browser launched with PID: {}", process.id());

        // Wait for the debug port to become available
        wait_for_port(debug_port, Duration::from_secs(30))?;

        info!("Debug port {} is now available", debug_port);

        Ok(Self {
            session_id,
            debug_port,
            process,
        })
    }

    pub fn close(&mut self) {
        info!("Closing Windows browser session {}", self.session_id);
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

impl Drop for WindowsSession {
    fn drop(&mut self) {
        self.close();
    }
}

/// Find an available port starting from the given port
fn find_available_port(start_port: u16) -> u16 {
    for port in start_port..=65535 {
        if port_is_available(port) {
            return port;
        }
    }
    panic!("No available ports found starting from {}", start_port);
}

fn port_is_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let start = std::time::Instant::now();
    let poll_interval = Duration::from_millis(100);

    info!("Waiting for port {} to become available...", port);

    while start.elapsed() < timeout {
        if !port_is_available(port) {
            // Port is in use - browser is listening
            return Ok(());
        }
        std::thread::sleep(poll_interval);
    }

    Err(format!(
        "Timeout waiting for port {} after {:?}",
        port, timeout
    ))
}

/// Make an HTTP request to the CDP endpoint
pub fn cdp_request(port: u16, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let url = format!("http://localhost:{}{}", port, path);
    let client = reqwest::blocking::Client::new();

    let response = match method {
        "GET" => client
            .get(&url)
            .timeout(Duration::from_secs(30))
            .send()
            .map_err(|e| format!("CDP request failed: {}", e))?,
        "POST" => {
            let mut req = client.post(&url).timeout(Duration::from_secs(30));
            if let Some(b) = body {
                req = req.json(b);
            }
            req.send().map_err(|e| format!("CDP request failed: {}", e))?
        }
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    let text = response
        .text()
        .map_err(|e| format!("Failed to read response: {}", e))?;

    serde_json::from_str(&text).map_err(|e| format!("Failed to parse JSON: {} - body: {}", e, text))
}

/// Get the WebSocket debugger URL for the first available page
pub fn get_page_ws_url(port: u16) -> Result<String, String> {
    let targets: Vec<Value> = cdp_request(port, "GET", "/json", None)?
        .as_array()
        .ok_or("Expected array of targets")?
        .clone();

    for target in targets {
        if target.get("type").and_then(|t| t.as_str()) == Some("page") {
            if let Some(ws_url) = target.get("webSocketDebuggerUrl").and_then(|u| u.as_str()) {
                return Ok(ws_url.to_string());
            }
        }
    }

    Err("No page target found".to_string())
}

/// Execute JavaScript via CDP HTTP endpoint (simpler than WebSocket for basic operations)
pub fn execute_script_via_http(port: u16, script: &str) -> Result<String, String> {
    // Get the first page target
    let targets: Vec<Value> = cdp_request(port, "GET", "/json", None)?
        .as_array()
        .ok_or("Expected array of targets")?
        .clone();

    let page_id = targets
        .iter()
        .find(|t| t.get("type").and_then(|t| t.as_str()) == Some("page"))
        .and_then(|t| t.get("id").and_then(|id| id.as_str()))
        .ok_or("No page target found")?
        .to_string();

    // Use CDP send command endpoint
    // Note: For complex CDP operations, we'd use WebSocket, but for basic
    // script execution this HTTP approach via evaluate works
    
    // Actually, the /json endpoint doesn't support Runtime.evaluate directly
    // We need to return info for WebSocket connection or use a different approach
    
    // For now, return the page info - the actual script execution happens via WebSocket
    // which we'll handle in the handler
    Ok(format!("{{\"pageId\": \"{}\", \"port\": {}}}", page_id, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_port_availability() {
        let port = find_available_port(19000);
        assert!(port >= 19000);
        assert!(port_is_available(port));
    }
}

