param([switch] $UseLocalNode, [string] $OutputDirectory)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'packaging/release.json') -Raw | ConvertFrom-Json
$work = Join-Path $root ('.tmp/release-' + [guid]::NewGuid().ToString('N'))
$dist = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $root "dist/v$($config.version)" }
$stage = Join-Path $work 'payload'
New-Item -ItemType Directory -Path $stage, $dist -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
    $nodeDir = Join-Path $stage 'tools/node'
    New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
    $node = Join-Path $nodeDir 'node.exe'
    if ($UseLocalNode) {
        $localNode = (Get-Command node.exe -ErrorAction Stop).Source
        Copy-Item -LiteralPath $localNode -Destination $node
    } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$($config.nodeVersion)/win-x64/node.exe" -OutFile $node
    }
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne $config.nodeSha256) { throw 'Node.js checksum mismatch.' }
    $license = Join-Path $nodeDir 'LICENSE'
    Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/v$($config.nodeVersion)/LICENSE" -OutFile $license
    if ((Get-FileHash -LiteralPath $license -Algorithm SHA256).Hash -ne $config.nodeLicenseSha256) { throw 'Node.js license checksum mismatch.' }
    & $node --disable-warning=ExperimentalWarning --experimental-transform-types (Join-Path $root 'library/themes/gem-purple-stage-v3.1/build-theme.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Theme build failed.' }
    & $node --disable-warning=ExperimentalWarning --experimental-transform-types (Join-Path $root 'runtime/validate-theme.ts') (Join-Path $root 'library/themes/gem-purple-stage-v3.1')
    if ($LASTEXITCODE -ne 0) { throw 'Theme validation failed.' }
    $theme = Get-Content -LiteralPath (Join-Path $root 'library/themes/gem-purple-stage-v3.1/theme.json') -Raw | ConvertFrom-Json
    if ($theme.version -ne $config.version) { throw 'Theme and release versions differ.' }
    # Explicit allowlist: no source photographs, audit records, logs or local state.
    foreach ($name in @('README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'install.ps1', 'uninstall.ps1',
        'Install.cmd', 'Uninstall.cmd', 'install-gem-purple-shortcut.ps1', 'G.E.M. Purple Codex.vbs', 'start-gem-purple-codex.ps1')) {
        Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $stage $name)
    }
    foreach ($folder in @('launcher', 'runtime', 'library/themes/gem-purple-stage-v3.1')) {
        $destination = Join-Path $stage $folder
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        Get-ChildItem -LiteralPath (Join-Path $root $folder) -File | Where-Object {
            $_.Name -notmatch '\.test\.ts$' -and $_.Name -ne 'README.md'
        } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination }
    }
    $documentation = Join-Path $stage 'docs'
    New-Item -ItemType Directory -Path $documentation -Force | Out-Null
    foreach ($name in @('maintenance.md', 'release-validation.md', 'compatibility.md')) {
        Copy-Item -LiteralPath (Join-Path $root "docs/$name") -Destination $documentation
    }
    $assetDir = Join-Path $stage 'library/themes/gem-purple-stage-v3.1/assets'
    New-Item -ItemType Directory -Path $assetDir -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $root 'library/themes/gem-purple-stage-v3.1/assets') -File |
        Where-Object { $_.Extension -in @('.webp', '.woff2', '.txt') } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $assetDir }
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler is required.' }
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll "/out:$stage/GemPurpleCodex.exe" (Join-Path $root 'packaging/Launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
    # Windows PowerShell 5.1 requires a BOM to decode scripts containing non-ASCII text.
    Get-ChildItem -LiteralPath $stage -Recurse -File -Filter '*.ps1' | ForEach-Object {
        $content = [IO.File]::ReadAllText($_.FullName)
        [IO.File]::WriteAllText($_.FullName, $content, [Text.UTF8Encoding]::new($true))
    }
    $files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
        [ordered]@{ path = $_.FullName.Substring($stage.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    $manifest = [ordered]@{ productId = $config.productId; version = $config.version; architecture = $config.architecture; nodeVersion = $config.nodeVersion; files = $files }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stage 'install-manifest.json') -Encoding UTF8
    $stem = "gem-purple-stage-$($config.version)-windows-$($config.architecture)"
    $zip = Join-Path $dist "$stem-portable.zip"
    $setup = Join-Path $dist "$stem-setup.exe"
    foreach ($artifact in @($zip, $setup)) { if (Test-Path -LiteralPath $artifact) { throw "Release file already exists: $artifact" } }
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$zip,payload.zip" "/out:$setup" (Join-Path $root 'packaging/Setup.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
    @($setup, $zip) | ForEach-Object { '{0}  {1}' -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path -Leaf $_) } |
        Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ASCII
    Get-ChildItem -LiteralPath $dist -File | Select-Object Name, Length
} finally {
    $resolvedWork = [IO.Path]::GetFullPath($work)
    $allowed = [IO.Path]::GetFullPath((Join-Path $root '.tmp')) + '\'
    if (-not $resolvedWork.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build cleanup path is outside .tmp.' }
    if (Test-Path -LiteralPath $resolvedWork) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force }
}
