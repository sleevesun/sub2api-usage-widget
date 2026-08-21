# Parse exe PE by finding RT_GROUP_ICON resource bytes directly via PE parsing (no LoadLibrary callbacks)
# This is more robust and avoids PowerShell delegate issues
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"

$exe = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/target-alt/release/sub2api-usage-widget.exe"

# Read first 1MB for header parsing
$raw = [System.IO.File]::ReadAllBytes($exe)

function Get-U16($b,$o){ [BitConverter]::ToUInt16($b,$o) }
function Get-U32($b,$o){ [BitConverter]::ToUInt32($b,$o) }
function Get-I32($b,$o){ [BitConverter]::ToInt32($b,$o) }

$e_lfanew = Get-I32 $raw 0x3C
$sigOffset = $e_lfanew
if ((Get-U32 $raw $sigOffset) -ne 0x4550) { throw "not PE" }
$coffOff = $sigOffset + 4
$numSections = Get-U16 $raw ($coffOff + 2)
$sizeOpt = Get-U16 $raw ($coffOff + 16)
$optOff = $coffOff + 20
$magic = Get-U16 $raw $optOff
$isPE32Plus = ($magic -eq 0x20b)
$dataDirStart = $(if ($isPE32Plus) { 112 } else { 96 })
$numRvaAndSizes = Get-U32 $raw ($optOff + ($(if ($isPE32Plus) { 108 } else { 92 })))
$dirRsrcRva  = Get-U32 $raw ($optOff + ($dataDirStart + 2*8))
$dirRsrcSize = Get-U32 $raw ($optOff + ($dataDirStart + 2*8 + 4))
Write-Host "PE: sections=$numSections opt=0x$($magic.ToString('X4'))$(if ($isPE32Plus) {' (PE32+)'} else {' (PE32)'}) rsrcRva=0x$($dirRsrcRva.ToString('X8')) rsrcSize=$dirRsrcSize"

# Map RVA -> file offset using sections
$sectionTable = $optOff + $sizeOpt
$rvaToOffset = @{ }
$sectionsList = @()
for ($s=0; $s -lt $numSections; $s++) {
    $so = $sectionTable + $s * 40
    $nameBytes = $raw[$so..($so+7)]
    $name = ([System.Text.Encoding]::ASCII.GetString($nameBytes)).Trim([char]0)
    $vsize = Get-U32 $raw ($so + 8)
    $vaddr = Get-U32 $raw ($so + 12)
    $rsize = Get-U32 $raw ($so + 16)
    $rptr  = Get-U32 $raw ($so + 20)
    $sectionsList += [pscustomobject]@{ Name = $name; VA=$vaddr; VSize=$vsize; RawSize=$rsize; RawPtr=$rptr }
}
function rva2off($rva) {
    foreach ($sec in $script:sectionsList) {
        if ($rva -ge $sec.VA -and $rva -lt ($sec.VA + [Math]::Max($sec.VSize,$sec.RawSize))) {
            return [int](($rva - $sec.VA) + $sec.RawPtr)
        }
    }
    return -1
}

$rsrcRva = $dirRsrcRva
$rsrcOff = rva2off $rsrcRva
if ($rsrcOff -lt 0) { throw ".rsrc not found" }
Write-Host ".rsrc file offset = 0x$($rsrcOff.ToString('X8'))  first 4 bytes = $([System.BitConverter]::ToString($raw[$rsrcOff..($rsrcOff+3)]))"

# Walk Resource Directory: type level -> name level -> lang level -> DataEntry RVA points to IMAGE_RESOURCE_DATA_ENTRY
# Type IDs we want: RT_ICON=3, RT_GROUP_ICON=14
function Get-ResourceDir($baseOff, $dirRva) {
    # $baseOff = file offset of first IMAGE_RESOURCE_DIRECTORY in .rsrc
    # $dirRva = RVA of the directory we want (relative to start of .rsrc? NO - it's a relative offset from the base. Actually: resource directory entries' Name/ID field is a OFFSET (high bit set = subdirectory, offset from start of resource section))
    # Actually the resource tree uses "delta from resource section start" offsets.
    $delta = $baseOff
    $subOff = $dirRva  # if it's a relative offset it would still work using baseOff; let's test
}

# Actually easier approach: scan for RT_GROUP_ICON = 0x0E type, using the "resource type level" NamedEntries + ID entries count
$idDir = $rsrcOff
$characteristics = Get-U32 $raw $idDir          # skip
$tstamp = Get-U32 $raw ($idDir + 4)
$major = Get-U16 $raw ($idDir + 8); $minor = Get-U16 $raw ($idDir + 10)
$namedCount = Get-U16 $raw ($idDir + 12)
$idCount = Get-U16 $raw ($idDir + 14)
Write-Host "Root dir: named=$namedCount  id=$idCount"

$rtGroupIconDirOffset = -1
$rtIconDirOffset = -1
$baseRsrc = $idDir
for ($e = 0; $e -lt ($namedCount + $idCount); $e++) {
    $entryOff = $idDir + 16 + $e * 8
    $nameOrId = Get-U32 $raw $entryOff
    $offsetToDataOrSub = Get-U32 $raw ($entryOff + 4)
    $isDirectory = ($offsetToDataOrSub -band 0x80000000) -ne 0
    $idOnly = ($nameOrId -band 0x80000000) -eq 0  # no high bit => integer ID
    if ($idOnly) {
        $typeId = $nameOrId
        if ($isDirectory) {
            $subOff = $baseRsrc + ($offsetToDataOrSub -band 0x7FFFFFFF)
            if ($typeId -eq 14) { $script:rtGroupIconDirOffset = $subOff; Write-Host "Found RT_GROUP_ICON (type=14) sub-directory at 0x$($subOff.ToString('X8'))" }
            if ($typeId -eq 3)  { $script:rtIconDirOffset      = $subOff; Write-Host "Found RT_ICON (type=3) sub-directory at 0x$($subOff.ToString('X8'))" }
        }
    }
}
if ($rtGroupIconDirOffset -lt 0 -or $rtIconDirOffset -lt 0) { throw "Missing icon resource directories!" }

function Dump-Dir($label, $dirOff) {
    $nc = Get-U16 $raw ($dirOff + 12); $ic = Get-U16 $raw ($dirOff + 14)
    Write-Host "$label dir: named=$nc id=$ic"
    $results = @()
    for ($e=0; $e -lt ($nc + $ic); $e++) {
        $entryOff = $dirOff + 16 + $e * 8
        $nameOrId = Get-U32 $raw $entryOff
        $nextOff  = Get-U32 $raw ($entryOff + 4)
        $idOnly = ($nameOrId -band 0x80000000) -eq 0
        $isDir  = ($nextOff  -band 0x80000000) -ne 0
        if (-not $idOnly) { continue }
        if (-not $isDir) { continue }
        $next = $script:baseRsrc + ($nextOff -band 0x7FFFFFFF)
        $id = $nameOrId
        # Enter name dir -> expect exactly 1 language entry (most cases)
        $lnc = Get-U16 $raw ($next + 12); $lic = Get-U16 $raw ($next + 14)
        $totalLang = $lnc + $lic
        for ($l=0; $l -lt $totalLang; $l++) {
            $lEntryOff = $next + 16 + $l * 8
            $lNameOrId = Get-U32 $raw $lEntryOff
            $lNext = Get-U32 $raw ($lEntryOff + 4)
            if (($lNext -band 0x80000000) -ne 0) { continue }  # should be data
            $dataEntryOff = $script:baseRsrc + $lNext
            $dataRva  = Get-U32 $raw $dataEntryOff
            $dataSize = Get-U32 $raw ($dataEntryOff + 4)
            $cp = Get-U32 $raw ($dataEntryOff + 8)
            $rv = Get-U32 $raw ($dataEntryOff + 12)
            $fileOff = rva2off $dataRva
            $results += [pscustomobject]@{ Id=$id; DataRva=$dataRva; DataSize=$dataSize; FileOff=$fileOff }
        }
    }
    return $results
}
$script:baseRsrc = $baseRsrc
$grpItems = Dump-Dir "GROUP_ICON(14)" $rtGroupIconDirOffset
Write-Host ""
Write-Host "RT_GROUP_ICON items count = $($grpItems.Count)"
$iconDataMap = @{}  # RT_ICON id -> { DataRva, DataSize, FileOff }
$iconItems = Dump-Dir "ICON(3)" $rtIconDirOffset
foreach ($it in $iconItems) { $iconDataMap[[int]$it.Id] = $it }
Write-Host ""
Write-Host "RT_ICON items count = $($iconItems.Count) ids=$($iconItems.Id -join ',')"
Write-Host ""

$outDir = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/icon-dump"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# Use group icon dir info to parse GRPICONDIR (6 bytes header + 14 bytes per entry)
foreach ($grp in $grpItems) {
    $off = $grp.FileOff; $sz = $grp.DataSize
    Write-Host "GROUP_ICON id=$($grp.Id) bytes=$sz"
    $c = Get-U16 $raw ($off + 4)
    Write-Host "  entry count = $c"
    $entryOff = $off + 6
    for ($j = 0; $j -lt $c; $j++) {
        $w = $raw[$entryOff]; $h = $raw[$entryOff+1]; $col=$raw[$entryOff+2]
        $planes = Get-U16 $raw ($entryOff+4)
        $bpp    = Get-U16 $raw ($entryOff+6)
        $bytes  = Get-U32 $raw ($entryOff+8)
        $resId  = Get-U16 $raw ($entryOff+12)
        $ws = if ($w -eq 0) { 256 } else { $w }; $hs = if ($h -eq 0) { 256 } else { $h }
        Write-Host "  [$j] size=${ws}x${hs} planes=$planes bpp=$bpp bytes=$bytes -> RT_ICON id=$resId"
        $rtEntry = $iconDataMap[[int]$resId]
        if (-not $rtEntry) { Write-Host "    ^ MISSING in RT_ICON map!"; $entryOff += 14; continue }
        Write-Host "       RT_ICON fileOff=$($rtEntry.FileOff) raw_len=$($rtEntry.DataSize)"

        # Extract raw DIB bytes
        $dibBytes = New-Object byte[] $rtEntry.DataSize
        [Array]::Copy($raw, $rtEntry.FileOff, $dibBytes, 0, $rtEntry.DataSize)
        $biSig = $dibBytes[0]
        $biSize = Get-U32 $dibBytes 0
        $biW = Get-I32 $dibBytes 4
        $biH = Get-I32 $dibBytes 8
        $biPlanes = Get-U16 $dibBytes 12
        $biBpp = Get-U16 $dibBytes 14
        $biComp = Get-U32 $dibBytes 16
        Write-Host "       BITMAPINFO: biSize=$biSize w=$biW h=$biH planes=$biPlanes bpp=$biBpp comp=$biComp"
        if ($biComp -ne 0 -or $biSig -eq 0x89) { Write-Host "       ^ FAIL: not BI_RGB or PNG header!" }

        # Wrap as .BMP and save to PNG for pixel check
        $totalLen = 14 + $dibBytes.Length
        $withHead = New-Object byte[] $totalLen
        $withHead[0]=0x42; $withHead[1]=0x4D
        [BitConverter]::GetBytes([UInt32]$totalLen).CopyTo($withHead,2)
        [BitConverter]::GetBytes([UInt32](14+40)).CopyTo($withHead,10)  # pixel data offset right after BITMAPFILEHEADER + 40-byte INFOHDR (this is a lie, color palette could be present but for bpp>=24 no palette)
        [Array]::Copy($dibBytes, 0, $withHead, 14, $dibBytes.Length)
        try {
            $ms = New-Object System.IO.MemoryStream(,$withHead)
            $bmp = [System.Drawing.Bitmap]::FromStream($ms)
            $pw = $bmp.Width; $ph = $bmp.Height
            $cx = [int]($pw/2); $cy=[int]($ph/2)
            $p = $bmp.GetPixel($cx,$cy)
            $tag = if ($p.B -ge 230 -and $p.B -ge $p.R -and $p.B -ge $p.G) { "BLUE_ACCEPT" } `
              elseif ($p.R -ge 220 -and $p.R -gt $p.B -and ($p.R - $p.B) -ge 20) { "ORANGE_S2!!!!" } `
              else { "CHECK" }
            Write-Host "       SAVED dim=${pw}x${ph} center($cx,$cy) R=$($p.R.ToString().PadLeft(3)) G=$($p.G.ToString().PadLeft(3)) B=$($p.B.ToString().PadLeft(3)) -> $tag"
            $path = Join-Path $outDir ("PE-FINAL-{0}x{1}-id{2}.png" -f $pw,$ph,$resId)
            $bmp.Save($path,[System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose(); $ms.Dispose()
        } catch {
            Write-Host "       Bitmap.FromStream err: $_"
            # fallback: first 16 bytes of dib + header
            Write-Host "       dib[0..15] = $([System.BitConverter]::ToString($dibBytes[0..15]))"
        }
        $entryOff += 14
    }
}
