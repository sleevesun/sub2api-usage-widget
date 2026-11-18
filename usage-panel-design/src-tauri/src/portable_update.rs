use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, WebviewWindow};

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum DownloadEvent {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    Finished,
}

#[tauri::command]
pub(crate) async fn install_portable_update(
    app: AppHandle,
    window: WebviewWindow,
    version: String,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请在主窗口的设置中更新应用。".into());
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    return install(&app, &version, on_event).await;
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = (app, version, on_event);
        Err("自动更新适用于 Windows x64。".into())
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
async fn install(
    app: &AppHandle,
    version: &str,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_updater::UpdaterExt;

    static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _lock = INSTALL.try_lock().map_err(|_| "正在更新，请稍候。")?;
    let executable =
        tauri::process::current_binary(&app.env()).map_err(|_| "无法读取当前程序路径。")?;
    let expected_url = format!("https://github.com/sleevesun/sub2api-usage-widget/releases/download/v{version}/Sub2API-Usage_{version}_x64-portable.exe");
    let mut update = app
        .updater_builder()
        .target("windows-x86_64-portable")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "无法初始化绿色版更新。")?
        .check()
        .await
        .map_err(|_| "无法获取签名的绿色版更新，请稍后重试。")?
        .filter(|update| update.version == version && update.download_url.as_str() == expected_url)
        .ok_or("更新版本已变化或缺少绿色版，请重新检查更新。")?;
    update.timeout = Some(Duration::from_secs(180));
    let mut started = false;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {},
        )
        .await
        .map_err(|_| "更新下载或签名校验失败，当前版本未修改。")?;
    let _ = on_event.send(DownloadEvent::Finished);
    tauri::async_runtime::spawn_blocking(move || stage_and_replace(&executable, &bytes))
        .await
        .map_err(|_| "无法完成文件替换，请检查程序所在目录。")?
}

#[cfg(windows)]
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(windows)]
fn backup_path(executable: &Path) -> io::Result<PathBuf> {
    let file_name = executable.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    let mut name = std::ffi::OsString::from(".");
    name.push(file_name);
    name.push(".sub2api-update.old");
    Ok(executable.with_file_name(name))
}

#[cfg(windows)]
fn move_without_overwriting(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn replace_executable(executable: &Path, staged: &Path) -> Result<(), String> {
    let backup = backup_path(executable).map_err(|_| "无法读取当前程序文件名。")?;
    // Windows permits renaming a mapped executable, but rejects replacing it directly.
    move_without_overwriting(executable, &backup)
        .map_err(|_| "无法替换当前程序。请确认程序目录可写，并关闭其他正在运行的副本。")?;
    if move_without_overwriting(staged, executable).is_err() {
        return match move_without_overwriting(&backup, executable) {
            Ok(()) => Err("替换失败，原程序已恢复。请稍后重试。".into()),
            Err(_) => Err(format!(
                "替换失败，未能自动恢复。旧版本仍保存在 {}，请退出应用后恢复原文件名。",
                backup.display()
            )),
        };
    }
    Ok(())
}

#[cfg(windows)]
fn stage_and_replace(executable: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = executable.parent().ok_or("无法读取当前程序目录。")?;
    let mut staged = tempfile::Builder::new()
        .prefix(".sub2api-update-")
        .tempfile_in(parent)
        .map_err(|_| "程序目录不可写，请将 EXE 放到可写目录后重试。")?;
    staged
        .write_all(bytes)
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|_| "无法写入更新文件，请检查程序目录的权限和可用空间。")?;
    let staged = staged.into_temp_path();
    replace_executable(executable, &staged)
}

#[cfg(windows)]
pub(crate) fn cleanup_previous_executable(app: &AppHandle) {
    use tauri::Manager;
    let Ok(executable) = tauri::process::current_binary(&app.env()) else {
        return;
    };
    let Ok(backup) = backup_path(&executable) else {
        return;
    };
    if !backup.is_file() {
        return;
    }
    // Tauri starts the new process before the old process releases its mapped image.
    std::thread::spawn(move || {
        for _ in 0..40 {
            match fs::remove_file(&backup) {
                Ok(()) => return,
                Err(error)
                    if error.kind() == io::ErrorKind::PermissionDenied
                        || error.raw_os_error() == Some(32) =>
                {
                    std::thread::sleep(Duration::from_millis(250));
                }
                Err(_) => return,
            }
        }
    });
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{os::windows::process::CommandExt, process::Command};

    #[test]
    fn replaces_a_running_exe_at_its_original_path() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("custom name 中文.exe");
        let staged = dir.path().join("download.tmp");
        let system =
            std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        fs::copy(system.join("ping.exe"), &original).unwrap();
        let old = fs::read(&original).unwrap();
        fs::copy(system.join("where.exe"), &staged).unwrap();
        let new = fs::read(&staged).unwrap();
        let mut running = Command::new(&original)
            .args(["-t", "127.0.0.1"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let still_running = running.try_wait().unwrap().is_none();
        let result = replace_executable(&original, &staged);
        let _ = running.kill();
        running.wait().unwrap();
        assert!(still_running);
        result.unwrap();
        assert_eq!(fs::read(&original).unwrap(), new);
        assert_eq!(fs::read(backup_path(&original).unwrap()).unwrap(), old);
        Command::new(&original).arg("/?").output().unwrap();
        fs::remove_file(backup_path(&original).unwrap()).unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn restores_the_original_exe_if_promotion_fails() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("portable.exe");
        fs::write(&original, b"old executable").unwrap();
        assert!(replace_executable(&original, &dir.path().join("missing.tmp")).is_err());
        assert_eq!(fs::read(&original).unwrap(), b"old executable");
        assert!(!backup_path(&original).unwrap().exists());
    }

    #[test]
    fn existing_backup_blocks_a_second_replacement_without_overwriting_either_file() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("portable.exe");
        let backup = backup_path(&original).unwrap();
        let staged = dir.path().join("download.tmp");
        fs::write(&original, b"current executable").unwrap();
        fs::write(&backup, b"backup executable").unwrap();
        fs::write(&staged, b"new executable").unwrap();
        assert!(replace_executable(&original, &staged).is_err());
        assert_eq!(fs::read(&original).unwrap(), b"current executable");
        assert_eq!(fs::read(&backup).unwrap(), b"backup executable");
    }
}
