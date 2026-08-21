# Generate RC.EXE-compatible BMP-only ICO (no PNG entries!)
#
# Rules RC.EXE requires for 32bpp ARGB icon entries:
# 1. Each stored entry = DIB WITHOUT BITMAPFILEHEADER (starts at BITMAPINFOHEADER)
# 2. biHeight in INFOHEADER = iconHeight * 2  (XOR pixels + AND mask rows together)
# 3. biCompression = BI_RGB (0) — NEVER PNG
# 4. biBitCount = 32, biPlanes = 1
# 5. After XOR pixel rows (height * rowstride), append AND mask:
#    AND mask is 1bpp monochrome (0=opaque / 1=transparent), top-down, DWORD-aligned rows.
# 6. For 256x256 entry: ICONDIRENTRY width/height bytes = 0
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"

$iconDir = "c:\Users\sunxian125927\Documents\sub2api\usage-panel-design\src-tauri\icons"
$srcPath = Join-Path $iconDir "candidate-1-v2.jpg"
$outIco  = Join-Path $iconDir "icon.ico"

$src = [System.Drawing.Bitmap]::FromFile($srcPath)
$sizes = @(16, 32, 48, 64, 128, 256)

Write-Host "=== Building RC.EXE-safe BMP-only icon.ico ==="
$entries = New-Object System.Collections.Generic.List[object]

foreach ($sz in $sizes) {
    # 1) Render source -> 32bpp ARGB Bitmap at size sz x sz
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $sz, $sz)
    $g.Dispose()

    # 2) Build AND mask array (1bpp, each row DWORD-aligned in bytes -> (sz+31)/32 * 4)
    $andRowBytes = [int]([Math]::Ceiling($sz / 32.0) * 4)
    $andMask  = New-Object byte[] ($andRowBytes * $sz)

    # 3) Build DIB pixel blob:
    #    - BITMAPINFOHEADER (40 bytes, biHeight = 2*sz)
    #    - XOR pixels bottom-up BGRA8 (sz rows of sz*4 bytes)
    #    - AND mask top-down (sz rows of andRowBytes bytes, each 1=transparent)
    $rowBytes = $sz * 4  # 32bpp always DWORD aligned
    $xorSize  = $rowBytes * $sz
    $biSize   = 40
    $totalBytes = $biSize + $xorSize + ($andMask.Length)

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)

    # BITMAPINFOHEADER
    $bw.Write([UInt32]$biSize)                        # biSize
    $bw.Write([Int32]$sz)                             # biWidth
    $bw.Write([Int32]($sz * 2))                       # biHeight (doubled: XOR + AND)
    $bw.Write([UInt16]1)                              # biPlanes
    $bw.Write([UInt16]32)                             # biBitCount
    $bw.Write([UInt32]0)                              # biCompression = BI_RGB
    $bw.Write([UInt32]($xorSize + $andMask.Length))   # biSizeImage
    $bw.Write([Int32]0)                               # biXPelsPerMeter
    $bw.Write([Int32]0)                               # biYPelsPerMeter
    $bw.Write([UInt32]0)                              # biClrUsed
    $bw.Write([UInt32]0)                              # biClrImportant

    # XOR pixels — bottom-up order (row sz-1 first). BGRA, use ARGB values from bmp.
    for ($y = $sz - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $sz; $x++) {
            $px = $bmp.GetPixel($x, $y)
            $bw.Write([Byte]$px.B)
            $bw.Write([Byte]$px.G)
            $bw.Write([Byte]$px.R)
            $bw.Write([Byte]$px.A)
        }
    }

    # AND mask — 1bpp top-down (row 0 first). bit = 1 if A < 128 (transparent) else 0 (opaque)
    for ($y = 0; $y -lt $sz; $y++) {
        $rowStart = $y * $andRowBytes
        for ($x = 0; $x -lt $sz; $x++) {
            $px = $bmp.GetPixel($x, $y)
            if ($px.A -lt 128) {
                $bitIndex = 7 - ($x -band 7)
                $andMask[$rowStart + [int][Math]::Floor($x / 8)] = $andMask[$rowStart + [int][Math]::Floor($x / 8)] -bor [byte](1 -shl $bitIndex)
            }
        }
    }
    $bw.Write($andMask, 0, $andMask.Length)
    $bw.Flush()

    $rawBytes = $ms.ToArray()
    $bw.Dispose(); $ms.Dispose(); $bmp.Dispose()

    # sample pixel color
    $cx = [int]($sz/2); $cy = [int]($sz/2)
    $srcPx = $src.GetPixel($cx, $cy)

    $wByte = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
    $entries.Add([pscustomobject]@{
        Size     = [int]$sz
        RawBytes = $rawBytes
        Width    = $wByte
        Height   = $wByte
        Planes   = [UInt16]1
        BitCount = [UInt16]32
    })
    Write-Host ("  [{0}x{0}] entry_size={1,8}  src_center R={2} G={3} B={4}" -f $sz, $rawBytes.Length, $srcPx.R, $srcPx.G, $srcPx.B)
}
$src.Dispose()

# -------- Write the ICO file --------
$count = $entries.Count
$dirSize = 6 + (16 * $count)
$offset  = $dirSize
$fs = [System.IO.File]::Create($outIco)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$count)

# ICONDIRENTRY per size
foreach ($e in $entries) {
    $bw.Write([byte]$e.Width)
    $bw.Write([byte]$e.Height)
    $bw.Write([byte]0)                # color count
    $bw.Write([byte]0)                # reserved
    $bw.Write([UInt16]$e.Planes)
    $bw.Write([UInt16]$e.BitCount)
    $bw.Write([UInt32]$e.RawBytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $e.RawBytes.Length
}

# raw DIB blobs
foreach ($e in $entries) {
    $bw.Write($e.RawBytes, 0, $e.RawBytes.Length)
}
$bw.Flush(); $bw.Close()

$fi = Get-Item $outIco
Write-Host ""
Write-Host ("Wrote icon.ico: {0} bytes" -f $fi.Length)

# -------- Verify: parse each dir entry and check first byte of DIB header is 40 (BI_SIZE) not 0x89 (PNG sig) --------
$bytes = [System.IO.File]::ReadAllBytes($outIco)
$cnt   = [BitConverter]::ToUInt16($bytes, 4)
Write-Host ("Header count = {0}" -f $cnt)
$pngCount = 0; $bmpCount = 0
$off = 6
for ($i = 0; $i -lt $cnt; $i++) {
    $w = $bytes[$off]; $h = $bytes[$off+1]
    $bpp = [BitConverter]::ToUInt16($bytes, $off+6)
    $len = [BitConverter]::ToUInt32($bytes, $off+8)
    $dataOff = [BitConverter]::ToUInt32($bytes, $off+12)
    $ws = if ($w -eq 0) { 256 } else { $w }; $hs = if ($h -eq 0) { 256 } else { $h }
    $biSig = $bytes[$dataOff]
    $biSizeVerified = [BitConverter]::ToUInt32($bytes, [int]$dataOff)
    $biDoubleH = [BitConverter]::ToInt32($bytes, [int]$dataOff + 8)
    if ($biSig -eq 0x89 -and $bytes[([int]$dataOff)+1] -eq 0x50) { $pngCount++; $fmt = "PNG-BAD!" } else { $bmpCount++; $fmt = "BMP_OK  " }
    Write-Host ("  [{0}] {1}x{2} bpp={3} len={4,8}  biSigByte=0x{5:X2} biSize={6,3} biHeightDoubled={7,4} -> {8}" -f $i,$ws,$hs,$bpp,$len,$biSig,$biSizeVerified,$biDoubleH,$fmt)
    $off += 16
}
Write-Host ""
Write-Host ("Summary: PNG entries={0}  BMP entries={1}  ->  {2}" -f $pngCount, $bmpCount, $(if ($pngCount -eq 0) {"PASS (RC.EXE safe)"} else {"FAIL (RC.EXE will skip)"}))
