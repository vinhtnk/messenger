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
const MESSENGER_URL_ALT: &str = "https://facebook.com/messages";
const FACEBOOK_LOGIN_URL: &str = "https://www.facebook.com/login";
const FACEBOOK_CHECKPOINT_URL: &str = "https://www.facebook.com/checkpoint";

fn is_allowed_url(url: &str) -> bool {
    url.starts_with(MESSENGER_URL)
        || url.starts_with(MESSENGER_URL_ALT)
        || url.starts_with(FACEBOOK_LOGIN_URL)
        || url.starts_with(FACEBOOK_CHECKPOINT_URL)
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
                if is_allowed_url(url_str) {
                    return true;
                }
                // Open external URLs in default browser
                #[cfg(target_os = "macos")]
                {
                    let _ = std::process::Command::new("open").arg(url_str).spawn();
                }
                false
            })
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
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            eprintln!("Failed to create updater: {e}");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let accepted = app
                .dialog()
                .message(format!(
                    "A new version (v{}) is available. Would you like to download and install it?",
                    version
                ))
                .title("Update Available")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Download".into(), "Later".into()))
                .blocking_show();

            if !accepted {
                return;
            }

            // Download and install the update
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(_) => {
                    app.dialog()
                        .message("Update installed successfully. The app will now restart.")
                        .title("Update Complete")
                        .kind(MessageDialogKind::Info)
                        .blocking_show();
                    app.restart();
                }
                Err(e) => {
                    eprintln!("Failed to install update: {e}");
                    app.dialog()
                        .message(format!("Failed to install update: {e}"))
                        .title("Update Error")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                }
            }
        }
        Ok(None) => {
            // No update available
        }
        Err(e) => {
            eprintln!("Update check failed: {e}");
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
