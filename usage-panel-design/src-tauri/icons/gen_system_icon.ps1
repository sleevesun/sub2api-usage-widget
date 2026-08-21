Add-Type -AssemblyName System.Drawing

$iconDir = "c:\Users\sunxian125927\Documents\sub2api\usage-panel-design\src-tauri\icons"
$srcPath = Join-Path $iconDir "candidate-1-v2.jpg"
$outIco = Join-Path $iconDir "icon.ico"

$src = [System.Drawing.Bitmap]::FromFile($srcPath)

$sizes = @(16, 32, 48, 64, 128, 256)
$icons = @()

foreach ($sz in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $sz, $sz)
    $g.Dispose()
    
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $icons += $icon
    Write-Host "  Created $sz x $sz icon"
    $bmp.Dispose()
}

$src.Dispose()

# Save as ICO file using the Icon class
# First, we need to write a proper ICO file manually since Icon.Save() has limitations
$dirSize = 6 + (16 * $icons.Count)
$entryDataList = @()
$offsets = @()
$currentOffset = $dirSize

foreach ($icon in $icons) {
    $ms = New-Object System.IO.MemoryStream
    $icon.Save($ms)
    $iconBytes = $ms.ToArray()
    $ms.Close()
    $entryDataList += $iconBytes
    $offsets += $currentOffset
    $currentOffset += $iconBytes.Length
}

$fs = [System.IO.File]::Create($outIco)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR
$bw.Write([UInt16]0)  # reserved
$bw.Write([UInt16]1)  # type = 1 (icon)
$bw.Write([UInt16]$icons.Count)  # count

# ICONDIRENTRY for each
for ($i = 0; $i -lt $icons.Count; $i++) {
    $icon = $icons[$i]
    $sz = $sizes[$i]
    $wByte = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
    $hByte = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
    $bw.Write($wByte)
    $bw.Write($hByte)
    $bw.Write([byte]0)  # color count
    $bw.Write([byte]0)  # reserved
    $bw.Write([UInt16]1)  # color planes
    $bw.Write([UInt16]32)  # bits per pixel
    $bw.Write([UInt32]$entryDataList[$i].Length)
    $bw.Write([UInt32]$offsets[$i])
}

# Image data
foreach ($data in $entryDataList) {
    $bw.Write($data)
}

$bw.Flush()
$bw.Close()

# Cleanup icons
foreach ($icon in $icons) {
    $icon.Dispose()
}

$fi = Get-Item $outIco
Write-Host "icon.ico created: $($fi.Length) bytes"

# Verify
$testIcon = [System.Drawing.Icon]::FromFile($outIco)
Write-Host "Verified: icon size = $($testIcon.Size)"
$testIcon.Dispose()

$verify = [System.IO.File]::ReadAllBytes($outIco)
$br2 = New-Object System.IO.BinaryReader((New-Object System.IO.MemoryStream(,$verify)))
$r = $br2.ReadUInt16()
$t = $br2.ReadUInt16()
$c = $br2.ReadUInt16()
Write-Host "Header: reserved=$r type=$t count=$c"
for ($i = 0; $i -lt $c; $i++) {
    $w = $br2.ReadByte(); $h = $br2.ReadByte(); $col = $br2.ReadByte(); $res = $br2.ReadByte()
    $planes = $br2.ReadUInt16(); $bpp = $br2.ReadUInt16(); $size = $br2.ReadUInt32(); $offset = $br2.ReadUInt32()
    $vsz = if ($w -eq 0) { 256 } else { $w }
    Write-Host "  [$i]: ${vsz}x${vsz} bpp=$bpp size=$size"
}
$br2.Close()
