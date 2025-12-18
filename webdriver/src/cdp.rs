//! Chrome DevTools Protocol client for Windows
//! 
//! This module provides a simple CDP client that communicates with the browser
//! via WebSocket for script execution, navigation, and element finding.

#[cfg(windows)]
use tungstenite::{connect, Message};
#[cfg(windows)]
use uuid::Uuid;

use serde_json::{json, Value};
use std::time::Duration;

/// CDP client that communicates with the browser via WebSocket
#[cfg(windows)]
pub struct CdpClient {
    ws: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    command_id: u64,
}

#[cfg(windows)]
impl CdpClient {
    /// Connect to the browser's CDP WebSocket endpoint
    pub fn connect(port: u16) -> Result<Self, String> {
        // First, get the WebSocket URL from the JSON endpoint
        let ws_url = get_debugger_ws_url(port)?;
        
        info!("Connecting to CDP WebSocket: {}", ws_url);
        
        let (ws, _response) = connect(&ws_url)
            .map_err(|e| format!("Failed to connect to CDP WebSocket: {}", e))?;
        
        Ok(Self { ws, command_id: 0 })
    }

    /// Send a CDP command and wait for the response
    pub fn send_command(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.command_id += 1;
        let id = self.command_id;
        
        let command = json!({
            "id": id,
            "method": method,
            "params": params
        });
        
        let msg = Message::Text(command.to_string());
        self.ws.send(msg)
            .map_err(|e| format!("Failed to send CDP command: {}", e))?;
        
        // Wait for the response with matching ID
        loop {
            let response = self.ws.read()
                .map_err(|e| format!("Failed to read CDP response: {}", e))?;
            
            if let Message::Text(text) = response {
                let json: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("Failed to parse CDP response: {}", e))?;
                
                if json.get("id").and_then(|i| i.as_u64()) == Some(id) {
                    if let Some(error) = json.get("error") {
                        return Err(format!("CDP error: {}", error));
                    }
                    return Ok(json.get("result").cloned().unwrap_or(Value::Null));
                }
                // Not our response, could be an event - continue reading
            }
        }
    }

    /// Navigate to a URL
    pub fn navigate(&mut self, url: &str) -> Result<(), String> {
        self.send_command("Page.navigate", json!({ "url": url }))?;
        
        // Wait for page load
        self.send_command("Page.enable", json!({}))?;
        
        // Simple wait for load - in production you'd listen for Page.loadEventFired
        std::thread::sleep(Duration::from_millis(500));
        
        Ok(())
    }

    /// Execute JavaScript and return the result
    pub fn execute_script(&mut self, script: &str) -> Result<String, String> {
        let result = self.send_command("Runtime.evaluate", json!({
            "expression": script,
            "returnByValue": true,
            "awaitPromise": false
        }))?;
        
        // Extract the value from the result
        if let Some(value) = result.get("result").and_then(|r| r.get("value")) {
            Ok(value.to_string())
        } else if let Some(exception) = result.get("exceptionDetails") {
            Err(format!("Script exception: {}", exception))
        } else {
            Ok(result.to_string())
        }
    }

    /// Execute async JavaScript and wait for the promise
    pub fn execute_async_script(&mut self, script: &str) -> Result<String, String> {
        let result = self.send_command("Runtime.evaluate", json!({
            "expression": script,
            "returnByValue": true,
            "awaitPromise": true
        }))?;
        
        if let Some(value) = result.get("result").and_then(|r| r.get("value")) {
            Ok(value.to_string())
        } else if let Some(exception) = result.get("exceptionDetails") {
            Err(format!("Async script exception: {}", exception))
        } else {
            Ok(result.to_string())
        }
    }

    /// Get the current URL
    pub fn get_url(&mut self) -> Result<String, String> {
        let result = self.execute_script("window.location.href")?;
        // Remove quotes from JSON string
        Ok(result.trim_matches('"').to_string())
    }

    /// Find element using CSS selector, returns element object ID
    pub fn find_element(&mut self, selector: &str) -> Result<String, String> {
        // Get document root
        let doc = self.send_command("DOM.getDocument", json!({}))?;
        let root_id = doc.get("root")
            .and_then(|r| r.get("nodeId"))
            .and_then(|n| n.as_i64())
            .ok_or("Failed to get document root")?;
        
        // Query selector
        let result = self.send_command("DOM.querySelector", json!({
            "nodeId": root_id,
            "selector": selector
        }))?;
        
        let node_id = result.get("nodeId")
            .and_then(|n| n.as_i64())
            .ok_or("Element not found")?;
        
        if node_id == 0 {
            return Err("Element not found".to_string());
        }
        
        // Generate a unique element ID
        let element_id = Uuid::new_v4().to_string();
        
        // Store element reference via JS for later use
        let store_script = format!(
            r#"
            window.__ddg_elements = window.__ddg_elements || {{}};
            window.__ddg_elements['{}'] = document.querySelector('{}');
            '{}'
            "#,
            element_id, selector, element_id
        );
        self.execute_script(&store_script)?;
        
        Ok(element_id)
    }

    /// Click an element by its stored ID
    pub fn click_element(&mut self, element_id: &str) -> Result<(), String> {
        let script = format!(
            r#"
            const el = window.__ddg_elements && window.__ddg_elements['{}'];
            if (!el) throw new Error('Element not found');
            el.click();
            'clicked'
            "#,
            element_id
        );
        self.execute_script(&script)?;
        Ok(())
    }

    /// Create a new window/tab
    pub fn new_window(&mut self) -> Result<(String, String), String> {
        let result = self.send_command("Target.createTarget", json!({
            "url": "about:blank"
        }))?;
        
        let target_id = result.get("targetId")
            .and_then(|t| t.as_str())
            .ok_or("Failed to get new target ID")?
            .to_string();
        
        Ok((target_id.clone(), "tab".to_string()))
    }

    /// Get all window handles
    pub fn get_window_handles(&mut self) -> Result<Vec<String>, String> {
        let result = self.send_command("Target.getTargets", json!({}))?;
        
        let targets = result.get("targetInfos")
            .and_then(|t| t.as_array())
            .ok_or("Failed to get targets")?;
        
        let handles: Vec<String> = targets.iter()
            .filter(|t| t.get("type").and_then(|t| t.as_str()) == Some("page"))
            .filter_map(|t| t.get("targetId").and_then(|id| id.as_str()).map(String::from))
            .collect();
        
        Ok(handles)
    }

    /// Close current window
    pub fn close_window(&mut self) -> Result<(), String> {
        // Get current target info and close it
        let handles = self.get_window_handles()?;
        if let Some(target_id) = handles.first() {
            self.send_command("Target.closeTarget", json!({
                "targetId": target_id
            }))?;
        }
        Ok(())
    }
}

/// Get the WebSocket debugger URL from the browser's JSON endpoint
#[cfg(windows)]
fn get_debugger_ws_url(port: u16) -> Result<String, String> {
    let url = format!("http://localhost:{}/json", port);
    
    let response = reqwest::blocking::get(&url)
        .map_err(|e| format!("Failed to get CDP targets: {}", e))?
        .text()
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    let targets: Vec<Value> = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse targets JSON: {}", e))?;
    
    // Find the first page target
    for target in targets {
        if target.get("type").and_then(|t| t.as_str()) == Some("page") {
            if let Some(ws_url) = target.get("webSocketDebuggerUrl").and_then(|u| u.as_str()) {
                return Ok(ws_url.to_string());
            }
        }
    }
    
    Err("No page target with WebSocket URL found".to_string())
}

// Stub for non-Windows platforms to allow compilation
#[cfg(not(windows))]
pub struct CdpClient;

#[cfg(not(windows))]
impl CdpClient {
    pub fn connect(_port: u16) -> Result<Self, String> {
        Err("CDP client is only available on Windows".to_string())
    }
}

