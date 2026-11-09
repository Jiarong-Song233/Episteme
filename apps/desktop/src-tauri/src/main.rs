// No console window next to the program on Windows, except in development builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The desktop program: starts the workbench service it carries, shows the workbench in its own window, and keeps a
//! tray icon while the window is closed. The service is the same one `pnpm workbench` runs, on the same graph file
//! (`~/.episteme/workbench.db`) and the same port, so an agent connects to it the same way.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const PORT: u16 = 4322;
const MAIN: &str = "main";
/// Passed when the program starts with the system: it starts the service and stays in the tray.
const HIDDEN: &str = "--hidden";

/// The service this program started, if it started one rather than finding one already running.
#[derive(Default)]
struct Service(Mutex<Option<Child>>);

/// What answers on the workbench's port.
enum Port {
    Free,
    Workbench,
    Taken,
}

fn probe() -> Port {
    let address = SocketAddr::from(([127, 0, 0, 1], PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(400)) else {
        return Port::Free;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /manifest.json HTTP/1.0\r\nHost: 127.0.0.1:{PORT}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return Port::Taken;
    }
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer);
    if String::from_utf8_lossy(&answer).contains("学习工作台") {
        Port::Workbench
    } else {
        Port::Taken
    }
}

/// The last lines of what the service wrote, for the page that says it did not start.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(12)..].join("\n")
}

/// Starts the service, or uses the one already running, and waits until it answers.
fn start(app: &AppHandle) -> Result<(), String> {
    match probe() {
        Port::Workbench => return Ok(()),
        Port::Taken => {
            return Err(format!(
                "端口 {PORT} 被别的程序占用了。关掉那个程序，再重新打开 Episteme。"
            ))
        }
        Port::Free => {}
    }
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let node = resources
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let serve = resources.join("app").join("dist").join("serve.js");
    let logs = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log_path = logs.join("service.log");
    let log = File::create(&log_path).map_err(|e| e.to_string())?;

    let mut command = Command::new(&node);
    command
        .arg(&serve)
        .arg("--port")
        .arg(PORT.to_string())
        .env("EPISTEME_EXIT_WITH_STDIN", "1")
        .stdin(Stdio::piped())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("服务没能启动：{e}"))?;

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let said = fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!(
                "服务启动后退出了（{status}）。它最后说的是：\n\n{}\n\n完整记录在 {}",
                tail(&said),
                log_path.display()
            ));
        }
        if matches!(probe(), Port::Workbench) {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err(format!(
                "服务 30 秒内没有响应。记录在 {}",
                log_path.display()
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
    *app.state::<Service>().0.lock().unwrap() = Some(child);
    Ok(())
}

/// Stops the service this program started: closing its input lets it close the graph itself.
fn stop(app: &AppHandle) {
    let Some(mut child) = app.state::<Service>().0.lock().unwrap().take() else {
        return;
    };
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Episteme", true, None::<&str>)?;
    let starts = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart =
        CheckMenuItem::with_id(app, "autostart", "开机时启动", true, starts, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Episteme", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &autostart, &separator, &quit])?;
    let toggle = autostart.clone();
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Episteme")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show(app),
            "autostart" => {
                let launcher = app.autolaunch();
                let _ = if launcher.is_enabled().unwrap_or(false) {
                    launcher.disable()
                } else {
                    launcher.enable()
                };
                let _ = toggle.set_checked(launcher.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // Opening the program again shows the window that is already there instead of a second service.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show(app)
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN]),
        ))
        .manage(Service::default())
        .setup(|app| {
            let hidden = std::env::args().any(|argument| argument == HIDDEN);
            WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("Episteme")
                .inner_size(1180.0, 780.0)
                .min_inner_size(400.0, 560.0)
                .visible(!hidden)
                .build()?;
            tray(app.handle())?;
            let handle = app.handle().clone();
            thread::spawn(move || {
                let outcome = start(&handle);
                let Some(window) = handle.get_webview_window(MAIN) else {
                    return;
                };
                match outcome {
                    Ok(()) => {
                        let address = Url::parse(&format!("http://127.0.0.1:{PORT}/"))
                            .expect("a fixed address parses");
                        let _ = window.navigate(address);
                    }
                    Err(problem) => {
                        // The starting page may still be loading when the service fails at once.
                        thread::sleep(Duration::from_millis(600));
                        let message = serde_json::to_string(&problem).unwrap_or_default();
                        let _ = window.eval(format!("window.showProblem({message})"));
                        show(&handle);
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the service for the agents that use it; the tray menu quits.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("the program could not start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop(app);
            }
        });
}
