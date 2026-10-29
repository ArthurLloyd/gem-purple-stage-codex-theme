param(
    [Parameter(Mandatory = $true)][string] $AppUserModelId,
    [string] $ArgumentLine = ''
)

# MSIX apps need package activation to retain their package identity. Launching
# app\ChatGPT.exe directly causes APPMODEL_ERROR_NO_PACKAGE on this build.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace GemPurpleLauncher {
    [ComImport]
    [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        void ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    class ApplicationActivationManager { }

    public static class PackagedApp {
        public static uint Activate(string appUserModelId, string arguments) {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            try {
                uint processId;
                manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
                return processId;
            } finally {
                Marshal.ReleaseComObject(manager);
            }
        }
    }
}
'@

[GemPurpleLauncher.PackagedApp]::Activate($AppUserModelId, $ArgumentLine)
