Add-Type -AssemblyName System.Drawing

$iconDir = "c:\Users\sunxian125927\Documents\sub2api\usage-panel-design\src-tauri\icons"
$srcPath = Join-Path $iconDir "candidate-1-v2.jpg"
$outIco = Join-Path $iconDir "icon.ico"

$src = [System.Drawing.Bitmap]::FromFile($srcPath)

function Make-BmpBytes($bmp, $sz) {
    $stride = [int]([Math]::Ceiling($sz * 32 / 32.0) * 4)  # 32bpp = 4 bytes per pixel, 4-byte aligned
    $pxBytes = [byte[]]::new($stride * $sz)
    
    $rect = New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pxBytes, 0, $pxBytes.Length)
    $bmp.UnlockBits($data)
    
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
    $headerSize = 40  # BITMAPINFOHEADER
    $entrySize = $headerSize + $xorSize + $andSize
    
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    
    # BITMAPINFOHEADER (40 bytes)
    $bw.Write([UInt32]40)              # biSize
    $bw.Write([Int32]$sz)              # biWidth
    $bw.Write([Int32]($sz * 2))         # biHeight (doubled for XOR + AND mask)
    $bw.Write([UInt16]1)               # biPlanes
    $bw.Write([UInt16]32)              # biBitCount
    $bw.Write([UInt32]0)               # biCompression
    $bw.Write([UInt32]($xorSize + $andSize))  # biSizeImage
    $bw.Write([Int32]0)                # biXPelsPerMeter
    $bw.Write([Int32]0)                # biYPelsPerMeter
    $bw.Write([UInt32]0)               # biClrUsed
    $bw.Write([UInt32]0)               # biClrImportant
    
    # XOR mask (32bpp BGRA pixel data)
    $bw.Write($pxBytes)
    
    # AND mask (1bpp transparency)
    $bw.Write($andBytes)
    
    $bw.Flush()
    $result = $ms.ToArray()
    $bw.Close()
    $ms.Close()
    
    return ,@($entrySize, $result)
}

$sizes = @(16, 32, 48, 64, 128, 256)
$allEntries = @()
$allData = @()

foreach ($sz in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $sz, $sz)
    $g.Dispose()
    
    $result = Make-BmpBytes $bmp $sz
    $bmp.Dispose()
    
    $allEntries += [pscustomobject]@{
        w = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
        h = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
        entrySize = $result[0]
        data = $result[1]
    }
    $allData += ,$result[1]
    Write-Host "  Prepared ${sz}x${sz}: entrySize=$($result[0])"
}

$src.Dispose()

# Write ICO file
$count = $allEntries.Count
$dirSize = 6 + 16 * $count
$dataOffset = $dirSize

$fs = [System.IO.File]::Create($outIco)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$count)

# ICONDIRENTRY[]
foreach ($e in $allEntries) {
    $bw.Write($e.w)
    $bw.Write($e.h)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32][UInt32]$e.entrySize)
    $bw.Write([UInt32][UInt32]$dataOffset)
    $dataOffset += $e.entrySize
}

# Image data
foreach ($d in $allData) {
    $bw.Write($d)
}

$bw.Flush()
$bw.Close()

$fi = Get-Item $outIco
Write-Host "`nicon.ico: $($fi.Length) bytes"

# Verify structure
Write-Host "Verifying..."
$vbr = New-Object System.IO.BinaryReader((New-Object System.IO.MemoryStream([System.IO.File]::ReadAllBytes($outIco))))
$vbr.ReadUInt16() | Out-Null
$vbr.ReadUInt16() | Out-Null
$vc = $vbr.ReadUInt16()
Write-Host "Count: $vc"
for ($i = 0; $i -lt $vc; $i++) {
    $w = $vbr.ReadByte(); $h = $vbr.ReadByte(); $vbr.ReadByte() | Out-Null; $vbr.ReadByte() | Out-Null
    $vbr.ReadUInt16() | Out-Null; $vbr.ReadUInt16() | Out-Null
    $vsize = $vbr.ReadUInt32(); $voffset = $vbr.ReadUInt32()
    $vsz = if ($w -eq 0) { 256 } else { $w }
    $curPos = $vbr.BaseStream.Position
    $vbr.BaseStream.Position = $voffset
    $vbr.ReadUInt32() | Out-Null  # skip biSize
    $vbr.ReadInt32() | Out-Null    # width
    $vbr.ReadInt32() | Out-Null    # height
    $vbr.ReadUInt16() | Out-Null   # planes
    $vbpp = $vbr.ReadUInt16()
    $vbr.BaseStream.Position = $curPos
    Write-Host "  [$i]: ${vsz}x${vsz} bpp=$vbpp size=$vsize offset=$voffset"
}
$vbr.Close()

# Verify pixel data
Write-Host "`nVerifying pixel data in 32x32 entry..."
$verifyBmp = [System.Drawing.Bitmap]::FromFile((Join-Path $iconDir "32x32.png"))
$centerPixel = $verifyBmp.GetPixel(16, 16)
Write-Host "  Source 32x32 center pixel: R=$($centerPixel.R) G=$($centerPixel.G) B=$($centerPixel.B) A=$($centerPixel.A)"
$verifyBmp.Dispose()
