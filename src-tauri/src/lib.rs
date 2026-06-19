#[cfg(not(debug_assertions))]
use std::io::{Read, Write};
#[cfg(not(debug_assertions))]
use std::net::TcpStream;
#[cfg(not(debug_assertions))]
use std::path::PathBuf;
#[cfg(not(debug_assertions))]
use std::process::{Command, Stdio};
#[cfg(not(debug_assertions))]
use std::time::Duration;
#[cfg(all(not(debug_assertions), target_os = "windows"))]
use std::os::windows::process::CommandExt;
#[cfg(not(debug_assertions))]
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, TitleBarStyle};

#[cfg(all(not(debug_assertions), target_os = "windows"))]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(not(debug_assertions))]
fn find_available_port() -> std::io::Result<u16> {
    std::net::TcpListener::bind("127.0.0.1:0").and_then(|listener| listener.local_addr().map(|addr| addr.port()))
}

#[cfg(not(debug_assertions))]
fn wait_for_server(port: u16) {
    for _ in 0..100 {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
            let _ = stream.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");

            let mut buffer = [0; 64];
            if stream.read(&mut buffer).is_ok_and(|size| {
                std::str::from_utf8(&buffer[..size]).is_ok_and(|response| {
                    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.1 30")
                })
            }) {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    eprintln!("Timed out waiting for http://127.0.0.1:{port}");
}

#[cfg(not(debug_assertions))]
fn agent_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join(".deerhux").join("agent")
}

#[cfg(not(debug_assertions))]
fn server_pid_path() -> PathBuf {
    agent_dir().join("server.pid")
}

#[cfg(not(debug_assertions))]
fn scheduler_lock_path() -> PathBuf {
    agent_dir().join("scheduler.lock")
}

#[cfg(not(debug_assertions))]
fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
    }
}

#[cfg(not(debug_assertions))]
fn command_for_pid(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
    #[cfg(windows)]
    {
        let output = Command::new("wmic")
            .args(["process", "where", &format!("ProcessId={pid}"), "get", "CommandLine", "/value"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

#[cfg(not(debug_assertions))]
fn looks_like_deerhux_server(pid: u32) -> bool {
    command_for_pid(pid).is_some_and(|command| {
        command.contains("deerhux-server.js") || command.contains("next-server")
    })
}

#[cfg(not(debug_assertions))]
fn terminate_process(pid: u32) {
    if !is_process_alive(pid) {
        return;
    }

    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
        std::thread::sleep(Duration::from_millis(300));
        if is_process_alive(pid) {
            let _ = Command::new("kill").arg("-KILL").arg(pid.to_string()).status();
        }
    }

    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

#[cfg(not(debug_assertions))]
fn read_pid_file(path: &PathBuf) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse::<u32>().ok()
}

#[cfg(not(debug_assertions))]
fn read_scheduler_lock_pid() -> Option<u32> {
    let raw = std::fs::read_to_string(scheduler_lock_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("pid")?.as_u64().and_then(|pid| u32::try_from(pid).ok())
}

#[cfg(not(debug_assertions))]
fn cleanup_stale_backend_processes() {
    let pid_path = server_pid_path();
    if let Some(pid) = read_pid_file(&pid_path) {
        if looks_like_deerhux_server(pid) {
            terminate_process(pid);
        }
        let _ = std::fs::remove_file(&pid_path);
    }

    // Compatibility for builds before server.pid existed: the scheduler lock
    // stores the owning Next process pid. If it points at a DeerHux backend,
    // clear it so the new app instance owns scheduled jobs.
    if let Some(pid) = read_scheduler_lock_pid() {
        if looks_like_deerhux_server(pid) {
            terminate_process(pid);
            let _ = std::fs::remove_file(scheduler_lock_path());
        }
    }
}

#[cfg(not(debug_assertions))]
fn write_server_pid(pid: u32) {
    let dir = agent_dir();
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(server_pid_path(), pid.to_string());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let webview_url = if cfg!(debug_assertions) {
                "http://localhost:30141".to_string()
            } else {
                #[cfg(not(debug_assertions))]
                {
                    cleanup_stale_backend_processes();

                    let port = find_available_port()?;
                    let resource_dir = app.path().resource_dir()?;

                    // Resolve node binary — lives alongside the main executable in
                    // Contents/MacOS on macOS, or in the same dir on other platforms.
                    let exe_dir = std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                        .unwrap_or_else(|| resource_dir.clone());
                    let bundle_node = exe_dir.join("node");
                    let server_js = resource_dir.join("deerhux-server.js");

                    // On macOS, executables inside Contents/MacOS/ trigger a Dock
                    // icon when launched. Copy the node binary to a temp location
                    // outside the app bundle so macOS treats it as a plain daemon.
                    #[cfg(target_os = "macos")]
                    let spawn_node = {
                        let tmp = std::env::temp_dir().join("deerhux-node");
                        std::fs::create_dir_all(&tmp).ok();
                        let dest = tmp.join("node");
                        // Only copy if not already present (avoids repeated I/O on restart)
                        if !dest.exists() {
                            std::fs::copy(&bundle_node, &dest).ok();
                            use std::os::unix::fs::PermissionsExt;
                            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755)).ok();
                        }
                        dest
                    };
                    #[cfg(not(target_os = "macos"))]
                    let spawn_node = bundle_node;

                    let mut cmd = std::process::Command::new(&spawn_node);
                    cmd.arg(&server_js)
                        .env("DEERHUX_RESOURCE_DIR", &resource_dir)
                        .env("PORT", port.to_string())
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());

                    #[cfg(target_os = "windows")]
                    cmd.creation_flags(CREATE_NO_WINDOW);

                    let child = cmd.spawn()?;
                    write_server_pid(child.id());

                    wait_for_server(port);
                    format!("http://127.0.0.1:{port}")
                }
                #[cfg(debug_assertions)]
                unreachable!()
            };

            let builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(webview_url.parse()?),
            )
            .title("DeerHux")
            .inner_size(1280.0, 800.0)
            .min_inner_size(960.0, 640.0);

            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(LogicalPosition::new(14.0, 11.0));

            #[cfg(target_os = "windows")]
            let builder = builder
                .decorations(false);

            #[cfg(debug_assertions)]
            {
                let window = builder.build()?;
                window.open_devtools();
            }

            #[cfg(not(debug_assertions))]
            {
                builder.build()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
