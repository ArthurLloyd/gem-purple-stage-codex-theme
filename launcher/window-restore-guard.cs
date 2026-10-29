// Work around stale Electron minimum sizes when restoring on a mixed-DPI desktop.
// Runs only for the lifetime of the theme watcher; no app files or settings change.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace GemPurple {
    [StructLayout(LayoutKind.Sequential)]
    public struct WindowRect { public int Left, Top, Right, Bottom; }

    public sealed class WindowGeometry {
        public int Width, Height, Dpi;
        public IntPtr Monitor;
        public WindowRect WorkArea;
        public bool Maximized, Minimized;
    }

    public static class RestoreBoundsPolicy {
        public static bool ShouldRestore(WindowGeometry saved, WindowGeometry current) {
            if (saved.Maximized || current.Maximized || current.Minimized || saved.Dpi <= 0 ||
                saved.Width <= 0 || saved.Height <= 0 || saved.Dpi != current.Dpi ||
                saved.Monitor == IntPtr.Zero || saved.Monitor != current.Monitor ||
                !saved.WorkArea.Equals(current.WorkArea)) return false;
            // A smaller restore can be the OS adapting to a new work area. Only
            // repair enlargement, allowing for ordinary one-pixel frame rounding.
            return current.Width >= saved.Width - 2 && current.Height >= saved.Height - 2 &&
                (current.Width > saved.Width + 2 || current.Height > saved.Height + 2);
        }
    }

    public sealed class WindowRestoreGuard : IDisposable {
        [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct Placement {
            public int Length, Flags, Show;
            public Point Min, Max;
            public WindowRect Normal;
        }
        [StructLayout(LayoutKind.Sequential)] struct MonitorInfo {
            public int Size;
            public WindowRect Bounds, Work;
            public uint Flags;
        }
        sealed class Snapshot {
            public WindowGeometry Geometry;
            public long RestoreAt;
        }
        delegate void WinEventProc(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
        [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out WindowRect rect);
        [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

        readonly Dictionary<IntPtr, Snapshot> saved = new Dictionary<IntPtr, Snapshot>();
        readonly WinEventProc callback;
        readonly IntPtr hook;
        readonly System.Windows.Forms.Timer timer;
        readonly Process owner;
        readonly Stopwatch clock = Stopwatch.StartNew();

        WindowRestoreGuard(int ownerPid) {
            owner = Process.GetProcessById(ownerPid);
            callback = OnEvent;
            // Out-of-context WinEvents require a message pump. No visible form,
            // injected DLL, administrator privileges, or global service is used.
            hook = SetWinEventHook(0x000A, 0x0017, IntPtr.Zero, callback, 0, 0, 2);
            if (hook == IntPtr.Zero) throw new InvalidOperationException("Cannot observe window restore events.");
            timer = new System.Windows.Forms.Timer { Interval = 100 };
            timer.Tick += Tick;
            timer.Start();
            Console.WriteLine("Windows mixed-DPI restore guard active.");
        }

        static bool IsCodexWindow(IntPtr window) {
            // Exclude transparent avatar windows, tooltips, and other apps.
            if (!IsWindow(window) || (GetWindowLong(window, -16) & 0x00C00000) != 0x00C00000 ||
                (GetWindowLong(window, -20) & 0x08000080) != 0) return false;
            uint id;
            GetWindowThreadProcessId(window, out id);
            try {
                using (var process = Process.GetProcessById((int)id)) {
                    if (!String.Equals(process.ProcessName, "ChatGPT", StringComparison.OrdinalIgnoreCase)) return false;
                    string executable = process.MainModule.FileName;
                    return executable.IndexOf("\\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0 &&
                        executable.EndsWith("\\app\\ChatGPT.exe", StringComparison.OrdinalIgnoreCase);
                }
            } catch { return false; }
        }

        static WindowGeometry ReadGeometry(IntPtr window, bool beforeMinimize) {
            WindowRect rect;
            if (!GetWindowRect(window, out rect)) return null;
            var placement = new Placement();
            placement.Length = Marshal.SizeOf(placement);
            if (!GetWindowPlacement(window, ref placement)) return null;
            // MINIMIZESTART can arrive after the HWND moved to (-32000,-32000).
            // Normal placement retains the last physical width and height.
            if (beforeMinimize) rect = placement.Normal;
            IntPtr monitor = MonitorFromWindow(window, 2);
            var info = new MonitorInfo();
            info.Size = Marshal.SizeOf(info);
            if (!GetMonitorInfo(monitor, ref info)) return null;
            return new WindowGeometry {
                Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top,
                Dpi = (int)GetDpiForWindow(window), Monitor = monitor, WorkArea = info.Work,
                Maximized = IsZoomed(window) || (beforeMinimize && (placement.Flags & 2) != 0),
                Minimized = IsIconic(window)
            };
        }

        void OnEvent(IntPtr source, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time) {
            if (objectId != 0 || childId != 0) return;
            if (kind == 0x000A) { saved.Remove(window); return; } // User move/resize wins.
            if (kind != 0x0016 && kind != 0x0017) return;
            try {
                if (!IsCodexWindow(window)) { saved.Remove(window); return; }
                if (kind == 0x0016) {
                    var geometry = ReadGeometry(window, true);
                    if (geometry != null) saved[window] = new Snapshot { Geometry = geometry };
                } else {
                    Snapshot snapshot;
                    if (saved.TryGetValue(window, out snapshot)) snapshot.RestoreAt = clock.ElapsedMilliseconds + 350;
                }
            } catch { saved.Remove(window); }
        }

        void Tick(object sender, EventArgs args) {
            if (owner.HasExited) { Application.ExitThread(); return; }
            foreach (var pair in new List<KeyValuePair<IntPtr, Snapshot>>(saved)) {
                if (!IsWindow(pair.Key)) { saved.Remove(pair.Key); continue; }
                var snapshot = pair.Value;
                if (snapshot.RestoreAt == 0 || clock.ElapsedMilliseconds < snapshot.RestoreAt) continue;
                saved.Remove(pair.Key);
                if (!IsCodexWindow(pair.Key)) continue;
                var current = ReadGeometry(pair.Key, false);
                if (current == null || !RestoreBoundsPolicy.ShouldRestore(snapshot.Geometry, current)) continue;
                // Keep the restored position, z-order, and focus. Correct size once.
                if (SetWindowPos(pair.Key, IntPtr.Zero, 0, 0, snapshot.Geometry.Width, snapshot.Geometry.Height, 0x0216))
                    Console.WriteLine("Corrected Codex window enlargement after minimize/restore.");
            }
        }

        public static void Run(int ownerPid) {
            var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
            try { using (var guard = new WindowRestoreGuard(ownerPid)) Application.Run(); }
            finally { SetThreadDpiAwarenessContext(previous); }
        }

        public void Dispose() {
            timer.Stop(); timer.Dispose();
            UnhookWinEvent(hook);
            owner.Dispose();
        }
    }
}
