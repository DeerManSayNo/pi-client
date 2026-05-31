#[cfg(not(debug_assertions))]
use std::time::Duration;
use tauri::{WebviewUrl, WebviewWindowBuilder};
#[cfg(not(debug_assertions))]
use tauri::Manager;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

#[cfg(not(debug_assertions))]
fn wait_for_server(url: &str) {
    for _ in 0..100 {
        if std::net::TcpStream::connect("127.0.0.1:30141").is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    eprintln!("Timed out waiting for {url}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            {
                let resource_dir = app.path().resource_dir()?;
                let (_rx, child) = app
                    .shell()
                    .sidecar("node")?
                    .args([resource_dir.join("pi-agent-server.js")])
                    .env("PI_AGENT_RESOURCE_DIR", resource_dir)
                    .env("PORT", "30141")
                    .spawn()?;
                app.manage(child);
                wait_for_server("http://127.0.0.1:30141");
            }

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External("http://127.0.0.1:30141".parse()?),
            )
            .title("pi-agent")
            .inner_size(1280.0, 800.0)
            .min_inner_size(960.0, 640.0)
            .build()?;

            #[cfg(debug_assertions)]
            window.open_devtools();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
