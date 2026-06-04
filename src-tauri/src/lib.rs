#[cfg(not(debug_assertions))]
use std::io::{Read, Write};
#[cfg(not(debug_assertions))]
use std::net::TcpStream;
#[cfg(not(debug_assertions))]
use std::process::Stdio;
#[cfg(not(debug_assertions))]
use std::time::Duration;
use tauri::{WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, TitleBarStyle};

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
                    let port = find_available_port()?;
                    let resource_dir = app.path().resource_dir()?;

                    // Resolve node binary — lives alongside the main executable in
                    // Contents/MacOS on macOS, or in the same dir on other platforms.
                    let exe_dir = std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                        .unwrap_or_else(|| resource_dir.clone());
                    let bundle_node = exe_dir.join("node");
                    let server_js = resource_dir.join("pi-agent-server.js");

                    // On macOS, executables inside Contents/MacOS/ trigger a Dock
                    // icon when launched. Copy the node binary to a temp location
                    // outside the app bundle so macOS treats it as a plain daemon.
                    #[cfg(target_os = "macos")]
                    let spawn_node = {
                        let tmp = std::env::temp_dir().join("pi-agent-node");
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
                        .env("PI_AGENT_RESOURCE_DIR", &resource_dir)
                        .env("PORT", port.to_string())
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());

                    cmd.spawn()?;

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
            .title("pi-agent")
            .inner_size(1280.0, 800.0)
            .min_inner_size(960.0, 640.0);

            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(LogicalPosition::new(14.0, 11.0));

            let window = builder.build()?;

            #[cfg(debug_assertions)]
            window.open_devtools();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
