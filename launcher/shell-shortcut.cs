using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class GemPurpleShortcutShell {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern void SHChangeNotify(int eventId, uint flags, string item, IntPtr unused);

    // Use the Unicode shell-link interface directly. WScript.Shell's TargetPath
    // setter rejects valid executable paths on some clean Windows installations.
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, IntPtr data, uint flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription(IntPtr text, int size);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetWorkingDirectory(IntPtr path, int size);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
        void GetArguments(IntPtr text, int size);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int command);
        void SetShowCmd(int command);
        void GetIconLocation(IntPtr path, int size, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }
    public static void Save(string file, string target, string arguments, string directory, string icon) {
        object instance = new ShellLink();
        try {
            var link = (IShellLinkW)instance;
            link.SetPath(target);
            link.SetArguments(arguments);
            link.SetWorkingDirectory(directory);
            link.SetDescription("Launch Codex with G.E.M. Purple Stage v3.1");
            link.SetIconLocation(icon, 0);
            link.SetShowCmd(7);
            ((IPersistFile)instance).Save(file, true);
        } finally { Marshal.FinalReleaseComObject(instance); }
    }
    public static string ReadTarget(string file) {
        object instance = new ShellLink();
        try {
            ((IPersistFile)instance).Load(file, 0);
            var result = new StringBuilder(32768);
            ((IShellLinkW)instance).GetPath(result, result.Capacity, IntPtr.Zero, 4);
            return result.ToString();
        } finally { Marshal.FinalReleaseComObject(instance); }
    }
}
