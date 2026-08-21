Add-Type -AssemblyName System.Drawing

$iconDir = "c:\Users\sunxian125927\Documents\sub2api\usage-panel-design\src-tauri\icons"
$srcPath = Join-Path $iconDir "candidate-1-v2.jpg"
$outIco = Join-Path $iconDir "icon.ico"

$src = [System.Drawing.Bitmap]::FromFile($srcPath)

$sizes = @(16, 32, 48, 64, 128, 256)
$dirEntries = [System.Collections.ArrayList]::new()
$imageBlobs = [System.Collections.ArrayList]::new()

foreach ($sz in $sizes) {
    # Render to bitmap
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $sz, $sz)
    $g.Dispose()

    # Extract BGRA pixel bytes
    $rect = New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)
    $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $bd.Stride
    $pxBytes = [byte[]]::new($stride * $sz)
    [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $pxBytes, 0, $pxBytes.Length)
    $bmp.UnlockBits($bd)
    $bmp.Dispose()

    # Build AND mask
    $andStride = [int][Math]::Ceiling($sz / 32.0) * 4
    $andBytes = [byte[]]::new($andStride * $sz)
    for ($y = 0; $y -lt $sz; $y++) {
        for ($x = 0; $x -lt $sz; $x++) {
            $a = $pxBytes[$y * $stride + $x * 4 + 3]
            if ($a -lt 128) {
                $bi = $y * $andStride + [int]($x / 8)
                $andBytes[$bi] = $andBytes[$bi] -bor (1 -shl (7 - ($x % 8)))
            }
        }
    }

    # Build BMP info header + XOR + AND as one byte array
    $xorSize = $pxBytes.Length
    $andSize = $andBytes.Length
    $entrySize = 40 + $xorSize + $andSize

    $blob = [byte[]]::new($entrySize)
    $p = 0
    [BitConverter]::GetBytes([UInt32]40).CopyTo($blob, $p); $p += 4
    [BitConverter]::GetBytes([Int32]$sz).CopyTo($blob, $p); $p += 4
    [BitConverter]::GetBytes([Int32]($sz * 2)).CopyTo($blob, $p); $p += 4
    [BitConverter]::GetBytes([UInt16]1).CopyTo($blob, $p); $p += 2
    [BitConverter]::GetBytes([UInt16]32).CopyTo($blob, $p); $p += 2
    [BitConverter]::GetBytes([UInt32]0).CopyTo($blob, $p); $p += 4
    [BitConverter]::GetBytes([UInt32]($xorSize + $andSize)).CopyTo($blob, $p); $p += 4
    [BitConverter]::GetBytes([Int32]0).CopyTo($blob, $p); $p += 4
    [BitConverter]::GetBytes([Int32]0).CopyTo($blob, $p); $p += 4
    [BitConverter]::GetBytes([UInt32]0).CopyTo($blob, $p); $p += 4
    [BitConverter]::GetBytes([UInt32]0).CopyTo($blob, $p); $p += 4
    $pxBytes.CopyTo($blob, $p); $p += $xorSize
    $andBytes.CopyTo($blob, $p)

    $wByte = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
    $hByte = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }

    $dirEntries.Add([pscustomobject]@{
        W = $wByte; H = $hByte; Size = $entrySize; Data = $blob
    }) | Out-Null

    Write-Host "  ${sz}x${sz}: entrySize=$entrySize stride=$stride andStride=$andStride"
}
$src.Dispose()

# Assemble ICO
$count = $dirEntries.Count
$dirSize = 6 + 16 * $count
$dataOffset = $dirSize

$fs = [System.IO.File]::Create($outIco)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$count)

# ICONDIRENTRY (calculate offsets first)
$offsets = @()
foreach ($e in $dirEntries) {
    $offsets += $dataOffset
    $dataOffset += $e.Size
}

for ($i = 0; $i -lt $count; $i++) {
    $e = $dirEntries[$i]
    $bw.Write($e.W)
    $bw.Write($e.H)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32][UInt32]$e.Size)
    $bw.Write([UInt32][UInt32]$offsets[$i])
}

foreach ($e in $dirEntries) {
    $bw.Write($e.Data)
}

$bw.Flush()
$bw.Close()

$fi = Get-Item $outIco
Write-Host "`nicon.ico: $($fi.Length) bytes"

# VERIFY every part
Write-Host "`n=== VERIFICATION ==="
$all = [System.IO.File]::ReadAllBytes($outIco)
Write-Host "File read: $($all.Length) bytes"

# Check header
$h = [BitConverter]::ToUInt16($all, 0)
$t = [BitConverter]::ToUInt16($all, 2)
$c = [BitConverter]::ToUInt16($all, 4)
Write-Host "Dir: reserved=$h type=$t count=$c"

# Check each entry
for ($i = 0; $i -lt $c; $i++) {
    $base = 6 + $i * 16
    $ew = $all[$base]
    $eh = $all[$base + 1]
    $ebpp = [BitConverter]::ToUInt16($all, $base + 6)
    $esize = [BitConverter]::ToUInt32($all, $base + 8)
    $eoffset = [BitConverter]::ToUInt32($all, $base + 12)
    $vsz = if ($ew -eq 0) { 256 } else { $ew }

    # Check the BMP header at offset
    $bhSize = [BitConverter]::ToUInt32($all, $eoffset)
    $bhWidth = [BitConverter]::ToInt32($all, $eoffset + 4)
    $bhHeight = [BitConverter]::ToInt32($all, $eoffset + 8)

    $ok = if ($bhSize -eq 40 -and $bhWidth -eq $vsz) { "OK" } else { "CORRUPTED" }
    Write-Host "  [$i] ${vsz}x${vsz}: dirSize=$esize dirOffset=$eoffset BMP: biSize=$bhSize width=$bhWidth $ok"

    if ($ok -eq "OK") {
        # Check first pixel (BGRA)
        $pxOff = $eoffset + 40
        $pb = $all[$pxOff]; $pg = $all[$pxOff+1]; $pr = $all[$pxOff+2]; $pa = $all[$pxOff+3]
        Write-Host "       pixel(0,0): B=$pb G=$pg R=$pr A=$pa"
    }
}
