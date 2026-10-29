using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher {
    [STAThread]
    private static int Main() {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "launcher", "start-gem-purple-codex.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("Launcher files are missing. Reinstall the theme.", script);
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            Process.Start(new ProcessStartInfo(powershell,
                "-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File \"" + script + "\" -AllowForceRestart") {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root
            });
            return 0;
        } catch (Exception error) {
            MessageBox.Show(error.Message, "G.E.M. Purple Codex", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
