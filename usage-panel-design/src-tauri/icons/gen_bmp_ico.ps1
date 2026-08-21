Add-Type -AssemblyName System.Drawing

$iconDir = "c:\Users\sunxian125927\Documents\sub2api\usage-panel-design\src-tauri\icons"
$srcPath = Join-Path $iconDir "candidate-1-v2.jpg"
$outIco = Join-Path $iconDir "icon.ico"

$src = [System.Drawing.Bitmap]::FromFile($srcPath)

$sizes = @(16, 32, 48, 64, 128, 256)
$bmpDataList = @()

foreach ($sz in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $sz, $sz)
    $g.Dispose()

    $rect = New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $pxBytes = [byte[]]::new($stride * $sz)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pxBytes, 0, $pxBytes.Length)
    $bmp.UnlockBits($data)
    $bmp.Dispose()

    $andStride = [int]([Math]::Ceiling($sz / 32.0) * 4)
    $andBytes = [byte[]]::new($andStride * $sz)
    for ($y = 0; $y -lt $sz; $y++) {
        for ($x = 0; $x -lt $sz; $x++) {
            $alpha = $pxBytes[$y * $stride + $x * 4 + 3]
            if ($alpha -lt 128) {
                $byteIdx = $y * $andStride + [int]($x / 8)
                $bitIdx = 7 - ($x % 8)
                $andBytes[$byteIdx] = $andBytes[$byteIdx] -bor (1 -shl $bitIdx)
            }
        }
    }

    $xorSize = $pxBytes.Length
    $andSize = $andBytes.Length
    $infoHeaderSize = 40
    $entrySize = $infoHeaderSize + $xorSize + $andSize

    $wByte = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
    $hByte = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([UInt32]40)
    $bw.Write([Int32]$sz)
    $bw.Write([Int32]($sz * 2))
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]0)
    $bw.Write([UInt32]($xorSize + $andSize))
    $bw.Write([Int32]0)
    $bw.Write([Int32]0)
    $bw.Write([UInt32]0)
    $bw.Write([UInt32]0)
    $bw.Write($pxBytes)
    $bw.Write($andBytes)
    $bw.Flush()
    $entryData = $ms.ToArray()
    $bw.Close()
    $ms.Close()

    $bmpDataList += [pscustomobject]@{
        w = $wByte
        h = $hByte
        entrySize = $entrySize
        data = $entryData
    }
    Write-Host "  prepared ${sz}x${sz}: entrySize=$entrySize"
}

$src.Dispose()

$count = $bmpDataList.Count
$dirSize = 6 + 16 * $count
$dataOffset = $dirSize

$finalMs = New-Object System.IO.MemoryStream
$fbw = New-Object System.IO.BinaryWriter($finalMs)
$fbw.Write([UInt16]0)
$fbw.Write([UInt16]1)
$fbw.Write([UInt16]$count)

foreach ($e in $bmpDataList) {
    $fbw.Write([byte]$e.w)
    $fbw.Write([byte]$e.h)
    $fbw.Write([byte]0)
    $fbw.Write([byte]0)
    $fbw.Write([UInt16]1)
    $fbw.Write([UInt16]32)
    $fbw.Write([UInt32][UInt32]$e.entrySize)
    $fbw.Write([UInt32][UInt32]$dataOffset)
    $dataOffset += $e.entrySize
}

foreach ($e in $bmpDataList) {
    $fbw.Write($e.data)
}

$fbw.Flush()
[System.IO.File]::WriteAllBytes($outIco, $finalMs.ToArray())
$fbw.Close()
$finalMs.Close()

$fi = Get-Item $outIco
Write-Host "icon.ico DONE: $($fi.Length) bytes"

Write-Host "Verifying..."
$verifyBytes = [System.IO.File]::ReadAllBytes($outIco)
$vbr = New-Object System.IO.BinaryReader((New-Object System.IO.MemoryStream(,$verifyBytes)))
$vr = $vbr.ReadUInt16()
$vt = $vbr.ReadUInt16()
$vc = $vbr.ReadUInt16()
Write-Host "Header OK: reserved=$vr type=$vt count=$vc"
for ($i = 0; $i -lt $vc; $i++) {
    $vw = $vbr.ReadByte()
    $vh = $vbr.ReadByte()
    $vc2 = $vbr.ReadByte()
    $vres = $vbr.ReadByte()
    $vplanes = $vbr.ReadUInt16()
    $vbpp = $vbr.ReadUInt16()
    $vsize = $vbr.ReadUInt32()
    $voffset = $vbr.ReadUInt32()
    $vsz = if ($vw -eq 0) { 256 } else { $vw }
    $curPos = $vbr.BaseStream.Position
    $vbr.BaseStream.Position = $voffset
    $firstDword = $vbr.ReadUInt32()
    $vbr.BaseStream.Position = $curPos
    $fmt = if ($firstDword -eq 0x00000028) { "BMP/DIB (BITMAPINFOHEADER)" } elseif ($firstDword -eq 0x474E5089) { "PNG" } else { "UNKNOWN" }
    Write-Host "  [$i]: ${vsz}x${vsz} bpp=$vbpp size=$vsize fmt=$fmt"
}
$vbr.Close()
