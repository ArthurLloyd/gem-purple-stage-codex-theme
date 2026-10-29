using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Drawing;

internal static class Setup {
    private static readonly string DefaultTarget = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GemPurpleCodex");
    [STAThread]
    private static int Main(string[] args) {
        string target = DefaultTarget;
        bool quiet = false, noShortcuts = false;
        foreach (string arg in args) {
            if (arg.Equals("/quiet", StringComparison.OrdinalIgnoreCase)) quiet = true;
            else if (arg.Equals("/no-shortcuts", StringComparison.OrdinalIgnoreCase)) noShortcuts = true;
            else if (arg.StartsWith("/target:", StringComparison.OrdinalIgnoreCase)) target = arg.Substring(8);
            else return 2;
        }
        if (quiet) return Install(target, noShortcuts);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new Form { Text = "G.E.M. Purple Stage - 安装", ClientSize = new Size(570, 235),
                StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false }) {
            var label = new Label { Text = "为 Windows Codex 安装紫色舞台主题\n内置 Node.js，无需管理员权限。目标电脑需已安装 Codex。", AutoSize = true, Location = new Point(20, 20) };
            var path = new TextBox { Text = target, Location = new Point(20, 80), Width = 435 };
            var browse = new Button { Text = "浏览…", Location = new Point(465, 78), Width = 80 };
            var status = new Label { Text = "安装不会启动或重启 Codex。", Location = new Point(20, 125), Size = new Size(530, 40) };
            var install = new Button { Text = "安装 / 更新", Location = new Point(415, 180), Size = new Size(130, 32) };
            browse.Click += delegate { using (var dialog = new FolderBrowserDialog { SelectedPath = path.Text }) { if (dialog.ShowDialog(form) == DialogResult.OK) path.Text = dialog.SelectedPath; } };
            bool busy = false;
            int result = 1;
            form.FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
            install.Click += async delegate {
                busy = true; install.Enabled = browse.Enabled = path.Enabled = false;
                status.Text = "正在校验并安装，请稍候…";
                string destination = path.Text;
                result = await Task.Run(() => Install(destination, noShortcuts));
                busy = false;
                status.Text = result == 0 ? "安装完成。请从桌面或开始菜单的 G.E.M. Purple Codex 启动。" : "安装失败，请查看临时目录中的安装日志。";
                MessageBox.Show(form, result == 0 ? "安装完成。运行中的工作请先保存，再使用主题专用入口。" : "安装失败。日志：" + LogPath,
                    "G.E.M. Purple Stage", MessageBoxButtons.OK, result == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Error);
                if (result == 0) form.Close();
                else install.Enabled = browse.Enabled = path.Enabled = true;
            };
            form.Controls.AddRange(new Control[] { label, path, browse, status, install });
            Application.Run(form);
            return result;
        }
    }
    private static readonly string LogPath = Path.Combine(Path.GetTempPath(), "gem-purple-setup.log");
    private static int Install(string target, bool noShortcuts) {
        string temporary = Path.Combine(Path.GetTempPath(), "gem-purple-setup-" + Guid.NewGuid().ToString("N"));
        try {
            if (!Environment.Is64BitOperatingSystem) throw new Exception("64-bit Windows is required.");
            Directory.CreateDirectory(temporary);
            using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
                if (resource == null) throw new Exception("Installer payload is missing.");
                using (var zip = new ZipArchive(resource, ZipArchiveMode.Read)) {
                    foreach (var entry in zip.Entries) {
                        string output = Path.GetFullPath(Path.Combine(temporary, entry.FullName));
                        if (!output.StartsWith(temporary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Invalid package path.");
                        if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(output); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(output));
                        entry.ExtractToFile(output);
                    }
                }
            }
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            if (String.IsNullOrWhiteSpace(target) || target.IndexOf('"') >= 0) throw new Exception("Invalid installation path.");
            // Canonicalize first: a trailing backslash must not escape the closing quote.
            target = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
            var start = new ProcessStartInfo(powershell, "-NoProfile -ExecutionPolicy RemoteSigned -File \"" + Path.Combine(temporary, "install.ps1") +
                "\" -InstallDirectory \"" + target + "\"" + (noShortcuts ? " -NoShortcuts" : "")) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                WorkingDirectory = temporary
            };
            using (var process = Process.Start(start)) {
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                Task<string> error = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                File.WriteAllText(LogPath, output.Result + Environment.NewLine + error.Result);
                return process.ExitCode;
            }
        } catch (Exception error) {
            File.WriteAllText(LogPath, error.ToString());
            return 1;
        } finally {
            if (Directory.Exists(temporary)) {
                try { Directory.Delete(temporary, true); }
                catch (Exception error) { File.AppendAllText(LogPath, "\nTemporary cleanup failed: " + temporary + "\n" + error.Message); }
            }
        }
    }
}
