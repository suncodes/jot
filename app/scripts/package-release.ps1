$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $PSScriptRoot
$metadata = Get-Content -LiteralPath (Join-Path $appRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $metadata.version
& node (Join-Path $PSScriptRoot "version.mjs") check
if ($LASTEXITCODE -ne 0) { throw "Release metadata validation failed." }

$dist = Join-Path $appRoot "dist"
$packed = Join-Path $dist "win-unpacked"
$installer = Join-Path $dist ("Jot Setup " + $version + ".exe")
$required = @("Jot.exe", "resources/app.asar", "resources/plugins/jot-core/plugin.json", "resources/app-extensions/work-diary/extension.json", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "licenses/THIRD_PARTY_LICENSES.txt", "PRIVACY.md", "LICENSE.electron.txt", "LICENSES.chromium.html")
foreach ($file in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $packed $file) -PathType Leaf)) { throw ("Missing packaged file: " + $file + ". Run pnpm app:dist first.") }
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Installer missing. Run pnpm app:dist first." }
& node (Join-Path $PSScriptRoot "version.mjs") check-packed $packed
if ($LASTEXITCODE -ne 0) { throw "Packaged application version validation failed." }

$release = Join-Path $dist "release"
New-Item -ItemType Directory -Path $release -Force | Out-Null
$setupName = "Jot-" + $version + "-windows-x64-setup.exe"
$zipName = "Jot-" + $version + "-windows-x64.zip"
Copy-Item -LiteralPath $installer -Destination (Join-Path $release $setupName) -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$tempZip = Join-Path $release ("candidate-" + [Guid]::NewGuid().ToString("N") + ".zip")
[System.IO.Compression.ZipFile]::CreateFromDirectory($packed, $tempZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Move-Item -LiteralPath $tempZip -Destination (Join-Path $release $zipName) -Force
$hashes = foreach ($name in @($setupName, $zipName)) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead((Join-Path $release $name))
  try { [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() + "  " + $name }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
Set-Content -LiteralPath (Join-Path $release "SHA256SUMS.txt") -Value $hashes -Encoding UTF8
Write-Output ("Release artifacts: " + $release)
