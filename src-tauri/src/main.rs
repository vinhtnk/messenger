// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    webview::WebviewWindowBuilder,
    AppHandle, Manager, WebviewUrl, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

const MESSENGER_URL: &str = "https://www.facebook.com/messages";

fn is_messenger_or_login_url(url: &str) -> bool {
    let allowed_paths = [
        "https://www.facebook.com/messages",
        "https://facebook.com/messages",
        "https://www.facebook.com/login",
        "https://www.facebook.com/checkpoint",
        "https://www.facebook.com/two_factor",
        "https://www.facebook.com/recover",
        "https://www.facebook.com/cookie",
        "https://www.facebook.com/privacy",
        "https://www.facebook.com/dialog",
        "https://m.facebook.com/login",
        "https://www.messenger.com/",
        "https://www.fbsbx.com/",
        "https://static.xx.fbcdn.net/",
    ];
    allowed_paths.iter().any(|path| url.starts_with(path))
}

// During login, Facebook redirects through various URLs on facebook.com.
// We allow all facebook.com navigation but use JS injection to open
// non-Messenger links clicked in conversations in the external browser.
fn is_facebook_domain(url: &str) -> bool {
    url.starts_with("https://www.facebook.com/")
        || url.starts_with("https://facebook.com/")
        || url.starts_with("https://m.facebook.com/")
        || url.starts_with("https://www.messenger.com/")
        || url.starts_with("https://www.fbsbx.com/")
        || url.starts_with("https://static.xx.fbcdn.net/")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            build_menu(app)?;

            // Create webview window with navigation handler
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(MESSENGER_URL.parse().unwrap()),
            )
            .title("Messenger")
            .inner_size(1200.0, 800.0)
            .min_inner_size(400.0, 600.0)
            .on_navigation(|url| {
                let url_str = url.as_str();

                // Always allow Messenger and login-related URLs
                if is_messenger_or_login_url(url_str) {
                    return true;
                }

                // Block external-open: scheme (from our JS injection) and open in browser
                if url_str.starts_with("external-open:") {
                    let real_url = &url_str["external-open:".len()..];
                    #[cfg(target_os = "macos")]
                    {
                        let _ = std::process::Command::new("open").arg(real_url).spawn();
                    }
                    return false;
                }

                // Allow other facebook.com pages during login flow
                if is_facebook_domain(url_str) {
                    return true;
                }

                // Open everything else in default browser
                #[cfg(target_os = "macos")]
                {
                    let _ = std::process::Command::new("open").arg(url_str).spawn();
                }
                false
            })
            .initialization_script(
                r#"
                // Intercept link clicks to open non-Messenger URLs in external browser
                document.addEventListener('click', function(e) {
                    const link = e.target.closest('a[href]');
                    if (!link) return;

                    const href = link.href;
                    if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;

                    // Allow Messenger navigation within the app
                    if (href.startsWith('https://www.facebook.com/messages') ||
                        href.startsWith('https://facebook.com/messages') ||
                        href.startsWith('https://www.messenger.com/')) {
                        return;
                    }

                    // Open everything else in external browser via custom scheme
                    e.preventDefault();
                    e.stopPropagation();
                    window.location.href = 'external-open:' + href;
                }, true);
                "#,
            )
            .build()?;

            // Check for updates on launch
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                check_for_updates(handle).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // macOS: hide window on close instead of quitting
            if let WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    window.hide().unwrap_or_default();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Messenger");
}

async fn check_for_updates(app: AppHandle) {
    // Delay update check to avoid blocking app startup
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            eprintln!("Failed to create updater: {e}");
            return;
        }
    };

    // Timeout the update check to avoid hanging
    let check_result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        updater.check(),
    )
    .await;

    let update = match check_result {
        Ok(Ok(Some(update))) => update,
        Ok(Ok(None)) => return,
        Ok(Err(e)) => {
            eprintln!("Update check failed: {e}");
            return;
        }
        Err(_) => {
            eprintln!("Update check timed out");
            return;
        }
    };

    let version = update.version.clone();
    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog()
        .message(format!(
            "A new version (v{}) is available. Would you like to download and install it?",
            version
        ))
        .title("Update Available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Download".into(), "Later".into()))
        .show(move |accepted| {
            let _ = tx.send(accepted);
        });

    // Wait for user response in async context without blocking UI
    let accepted = tokio::task::spawn_blocking(move || rx.recv().unwrap_or(false))
        .await
        .unwrap_or(false);

    if !accepted {
        return;
    }

    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(_) => {
            let (tx, rx) = std::sync::mpsc::channel();
            app.dialog()
                .message("Update installed successfully. The app will now restart.")
                .title("Update Complete")
                .kind(MessageDialogKind::Info)
                .show(move |_| {
                    let _ = tx.send(());
                });
            let _ = tokio::task::spawn_blocking(move || rx.recv()).await;
            app.restart();
        }
        Err(e) => {
            eprintln!("Failed to install update: {e}");
            app.dialog()
                .message(format!("Failed to install update: {e}"))
                .title("Update Error")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    }
}

fn build_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let check_updates_item = MenuItemBuilder::new("Check for Updates...")
        .id("check_updates")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Messenger")
        .about(None)
        .item(&check_updates_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let reload_item = MenuItemBuilder::new("Reload")
        .id("reload")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;

    let force_reload_item = MenuItemBuilder::new("Force Reload")
        .id("force_reload")
        .accelerator("CmdOrCtrl+Shift+R")
        .build(app)?;

    let zoom_in_item = MenuItemBuilder::new("Zoom In")
        .id("zoom_in")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;

    let zoom_out_item = MenuItemBuilder::new("Zoom Out")
        .id("zoom_out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;

    let reset_zoom_item = MenuItemBuilder::new("Reset Zoom")
        .id("reset_zoom")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let fullscreen_item = MenuItemBuilder::new("Toggle Full Screen")
        .id("fullscreen")
        .accelerator("Ctrl+CmdOrCtrl+F")
        .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&reload_item)
        .item(&force_reload_item)
        .separator()
        .item(&reset_zoom_item)
        .item(&zoom_in_item)
        .item(&zoom_out_item)
        .separator()
        .item(&fullscreen_item)
        .build()?;

    let close_window_item = MenuItemBuilder::new("Close Window")
        .id("close_window")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&close_window_item)
        .minimize()
        .separator()
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;

    // Handle custom menu events
    let app_handle = app.handle().clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().as_ref();
        if id == "check_updates" {
            let handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                check_for_updates(handle).await;
            });
            return;
        }
        if let Some(window) = app_handle.get_webview_window("main") {
            match id {
                "close_window" => {
                    window.hide().unwrap_or_default();
                }
                "reload" | "force_reload" => {
                    let _ = window.eval("window.location.reload()");
                }
                "zoom_in" => {
                    let _ = window.eval(
                        "document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) + 0.1).toString()",
                    );
                }
                "zoom_out" => {
                    let _ = window.eval(
                        "document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) - 0.1).toString()",
                    );
                }
                "reset_zoom" => {
                    let _ = window.eval("document.body.style.zoom = '1'");
                }
                "fullscreen" => {
                    if let Ok(is_fullscreen) = window.is_fullscreen() {
                        let _ = window.set_fullscreen(!is_fullscreen);
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}
