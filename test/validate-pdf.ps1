# Validate generated PDFs with the Windows PDF engine (the same one Edge uses).
# A file that fails here is rejected by real viewers, which is what catches
# structural mistakes that the plugin's own tolerant reader would accept.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/validate-pdf.ps1 <file.pdf> [<more.pdf>...]
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/validate-pdf.ps1 -Render <file.pdf>
#
# -Render also writes <name>.png next to the PDF (page 1) so the result can be
# inspected visually. Exit code 1 if any file fails to load.
param(
  [switch]$Render,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]

function Await($WinRtTask, $ResultType) {
  $task = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  try { $task.Wait(-1) | Out-Null } catch {
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    throw "$($ex.GetType().Name): $($ex.Message)"
  }
  $task.Result
}

function AwaitAction($WinRtTask) {
  $task = $asTaskAction.Invoke($null, @($WinRtTask))
  $task.Wait(-1) | Out-Null
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null

# WinRT only opens files under a few sandbox-visible roots, so stage a copy in
# %TEMP% and validate that instead of the original path.
$stage = Join-Path $env:TEMP ("dsh-has-pdfcheck-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$failed = 0
try {
  foreach ($input in $Paths) {
    $source = (Resolve-Path -LiteralPath $input).Path
    $staged = Join-Path $stage ((Split-Path -Leaf $source))
    try {
      Copy-Item -LiteralPath $source -Destination $staged -Force
    } catch {
      Write-Output ("SKIP {0}  (file is open in another program: {1})" -f $source, $_.Exception.Message)
      continue
    }
    try {
      $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($staged)) ([Windows.Storage.StorageFile])
      $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
      $page = $doc.GetPage(0)
      $size = "{0:N1} x {1:N1} pt" -f $page.Size.Width, $page.Size.Height
      Write-Output ("OK   {0}  pages={1}  page1={2}" -f $source, $doc.PageCount, $size)
      if ($Render) {
        $png = [System.IO.Path]::ChangeExtension($source, '.page1.png')
        $stream = [System.IO.File]::Create($png)
        $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream)
        AwaitAction ($page.RenderToStreamAsync($ras))
        $ras.Dispose()
        $stream.Dispose()
        Write-Output ("     rendered {0}" -f $png)
      }
    } catch {
      $failed += 1
      Write-Output ("FAIL {0}  {1}" -f $source, $_.Exception.Message)
    }
  }
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failed -eq 0) { exit 0 } else { exit 1 }
