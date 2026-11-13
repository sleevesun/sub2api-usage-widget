use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
fn cursor_lparam(x: i32, y: i32) -> isize {
    ((x as u16 as u32) | ((y as u16 as u32) << 16)) as isize
}

pub fn start(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "orb" {
        return Err("仅允许拖动悬浮球窗口".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::{
            Foundation::POINT,
            UI::{
                Input::KeyboardAndMouse::{
                    GetAsyncKeyState, ReleaseCapture, VK_LBUTTON, VK_RBUTTON,
                },
                WindowsAndMessaging::{
                    GetCursorPos, GetSystemMetrics, SendMessageW, HTCAPTION, SM_SWAPBUTTON,
                    WM_NCLBUTTONDOWN,
                },
            },
        };

        let drag_window = window.clone();
        return window
            .run_on_main_thread(move || unsafe {
                let Ok(hwnd) = drag_window.hwnd() else { return };
                let mut cursor = POINT { x: 0, y: 0 };
                if GetCursorPos(&mut cursor) == 0 {
                    return;
                }
                let button = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
                    VK_RBUTTON
                } else {
                    VK_LBUTTON
                };
                // A quick release can arrive before this queued task. Never start a
                // move loop after that release, which would swallow the next click.
                if GetAsyncKeyState(button as i32) >= 0 {
                    return;
                }
                ReleaseCapture();
                // Enter the OS move loop now, with physical screen coordinates.
                // Posting another message could put it behind the button release.
                SendMessageW(
                    hwnd.0,
                    WM_NCLBUTTONDOWN,
                    HTCAPTION as usize,
                    cursor_lparam(cursor.x, cursor.y),
                );
            })
            .map_err(|error| error.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    window.start_dragging().map_err(|error| error.to_string())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::cursor_lparam;

    #[test]
    fn native_drag_coordinates_support_monitors_on_either_side_of_the_origin() {
        for (x, y) in [(2307, 1125), (-1200, 900), (800, -400), (-1920, -1080)] {
            let packed = cursor_lparam(x, y);
            assert_eq!(packed as i16 as i32, x);
            assert_eq!((packed >> 16) as i16 as i32, y);
        }
    }
}
