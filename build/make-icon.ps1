Add-Type -AssemblyName System.Drawing
$srcPath = Join-Path $PSScriptRoot 'icon.png'
$src = [System.Drawing.Image]::FromFile($srcPath)
$sizes = @(256, 128, 64, 48, 32, 16)
$outDir = Split-Path $PSScriptRoot
$icoPath = Join-Path $outDir 'prompt-flow-manager.ico'

# 收集各尺寸 PNG 字节
$entries = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $pngMs = New-Object System.IO.MemoryStream
  $bmp.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $pngMs.ToArray()
  $pngMs.Dispose()
  $bmp.Dispose()
  $entries += ,@{ Bytes = $bytes; W = $s }
}
$src.Dispose()

# 组装 ICO
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$entries.Length)

$offset = 6 + ($entries.Length * 16)
foreach ($e in $entries) {
  $w = if ($e.W -eq 256) { [UInt16]0 } else { [UInt16]$e.W }
  $bw.Write([Byte]$w)
  $bw.Write([Byte]$w)
  $bw.Write([Byte]0)
  $bw.Write([Byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$e.Bytes.Length)
  $bw.Write([UInt32]$offset)
  $offset += $e.Bytes.Length
}
foreach ($e in $entries) {
  $bw.Write($e.Bytes)
}
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose()
$ms.Dispose()
Write-Host "Created: $icoPath"
