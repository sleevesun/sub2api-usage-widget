# Extract pixel samples from raw RT_ICON DIB bytes in the PE, using correct icon-DIB semantics (biHeight*2 + bottom-up XOR)
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"

$exe = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/target-alt/release/sub2api-usage-widget.exe"
$raw = [System.IO.File]::ReadAllBytes($exe)

function Get-U16($b,$o){ [BitConverter]::ToUInt16($b,$o) }
function Get-U32($b,$o){ [BitConverter]::ToUInt32($b,$o) }
function Get-I32($b,$o){ [BitConverter]::ToInt32($b,$o) }

$e_lfanew = Get-I32 $raw 0x3C
$sigOffset = $e_lfanew
$coffOff = $sigOffset + 4
$numSections = Get-U16 $raw ($coffOff + 2)
$sizeOpt = Get-U16 $raw ($coffOff + 16)
$optOff = $coffOff + 20
$magic = Get-U16 $raw $optOff
$isPE32Plus = ($magic -eq 0x20b)
$dataDirStart = $(if ($isPE32Plus) { 112 } else { 96 })
$dirRsrcRva  = Get-U32 $raw ($optOff + ($dataDirStart + 2*8))
$dirRsrcSize = Get-U32 $raw ($optOff + ($dataDirStart + 2*8 + 4))

$sectionTable = $optOff + $sizeOpt
$sectionsList = @()
for ($s=0; $s -lt $numSections; $s++) {
    $so = $sectionTable + $s * 40
    $name = ([System.Text.Encoding]::ASCII.GetString($raw[$so..($so+7)])).Trim([char]0)
    $vsize = Get-U32 $raw ($so + 8); $vaddr = Get-U32 $raw ($so + 12)
    $rsize = Get-U32 $raw ($so + 16); $rptr = Get-U32 $raw ($so + 20)
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
$baseRsrc = $rsrcOff
$script:baseRsrc = $baseRsrc

$idDir = $rsrcOff
$namedCount = Get-U16 $raw ($idDir + 12); $idCount = Get-U16 $raw ($idDir + 14)
$rtGroupIconDirOffset = -1; $rtIconDirOffset = -1
for ($e = 0; $e -lt ($namedCount + $idCount); $e++) {
    $entryOff = $idDir + 16 + $e * 8
    $nameOrId = Get-U32 $raw $entryOff
    $offsetToDataOrSub = Get-U32 $raw ($entryOff + 4)
    $isDirectory = ($offsetToDataOrSub -band 0x80000000) -ne 0
    if (($nameOrId -band 0x80000000) -eq 0 -and $isDirectory) {
        $subOff = $baseRsrc + ($offsetToDataOrSub -band 0x7FFFFFFF)
        if ($nameOrId -eq 14) { $rtGroupIconDirOffset = $subOff }
        if ($nameOrId -eq 3)  { $rtIconDirOffset = $subOff }
    }
}

function Dump-Dir($dirOff) {
    $nc = Get-U16 $raw ($dirOff + 12); $ic = Get-U16 $raw ($dirOff + 14)
    $results = @()
    for ($e=0; $e -lt ($nc + $ic); $e++) {
        $entryOff = $dirOff + 16 + $e * 8
        $nameOrId = Get-U32 $raw $entryOff
        $nextOff  = Get-U32 $raw ($entryOff + 4)
        if (($nameOrId -band 0x80000000) -ne 0) { continue }
        if (($nextOff -band 0x80000000) -eq 0) { continue }
        $next = $script:baseRsrc + ($nextOff -band 0x7FFFFFFF)
        $id = $nameOrId
        $lnc = Get-U16 $raw ($next + 12); $lic = Get-U16 $raw ($next + 14)
        for ($l=0; $l -lt ($lnc+$lic); $l++) {
            $lEntryOff = $next + 16 + $l * 8
            $lNext = Get-U32 $raw ($lEntryOff + 4)
            if (($lNext -band 0x80000000) -ne 0) { continue }
            $dataEntryOff = $script:baseRsrc + $lNext
            $dataRva  = Get-U32 $raw $dataEntryOff
            $dataSize = Get-U32 $raw ($dataEntryOff + 4)
            $fileOff = rva2off $dataRva
            $results += [pscustomobject]@{ Id=$id; DataRva=$dataRva; DataSize=$dataSize; FileOff=$fileOff }
        }
    }
    return $results
}

$grpItems = Dump-Dir $rtGroupIconDirOffset
$iconDataMap = @{}
foreach ($it in (Dump-Dir $rtIconDirOffset)) { $iconDataMap[[int]$it.Id] = $it }

Write-Host "=== FINAL PE RT_ICON verification (all 6 sizes) ==="
$allOk = $true
foreach ($grp in $grpItems) {
    $off = $grp.FileOff
    $c = Get-U16 $raw ($off + 4)
    $entryOff = $off + 6
    for ($j = 0; $j -lt $c; $j++) {
        $w = $raw[$entryOff]; $h = $raw[$entryOff+1]
        $planes = Get-U16 $raw ($entryOff+4)
        $bpp    = Get-U16 $raw ($entryOff+6)
        $bytes  = Get-U32 $raw ($entryOff+8)
        $resId  = Get-U16 $raw ($entryOff+12)
        $ws = if ($w -eq 0) { 256 } else { $w }; $hs = if ($h -eq 0) { 256 } else { $h }
        $rtEntry = $iconDataMap[[int]$resId]
        $dibStart = $rtEntry.FileOff

        # Parse BITMAPINFOHEADER manually, then sample XOR pixels bottom-up
        $biSize   = Get-U32 $raw $dibStart
        $biW      = Get-I32 $raw ($dibStart + 4)
        $biH_doubled = Get-I32 $raw ($dibStart + 8)
        $biPlanes = Get-U16 $raw ($dibStart + 12)
        $biBpp    = Get-U16 $raw ($dibStart + 14)
        $biComp   = Get-U32 $raw ($dibStart + 16)
        $iconH = [int]($biH_doubled / 2)   # actual height
        $xorStart = $dibStart + 40         # XOR rows follow immediately after 40-byte INFOHDR (no palette, 32bpp)

        # sample pixels: 4 points (corners + center) -> check for ORANGE dominance
        $samples = @(
            @{ Name="CENTER"; x=[int]($ws/2); y=[int]($ws/2) },
            @{ Name="RING_R"; x=[int]($ws*0.80); y=[int]($ws/2) },   # a blue-radar ring point
            @{ Name="TOP_L";  x=[int]($ws*0.18); y=[int]($ws*0.18) },
            @{ Name="MID_L";  x=[int]($ws*0.28); y=[int]($ws*0.55) }
        )
        $isOrange = $false; $isBlue = $false; $sampleOut = @()
        foreach ($s in $samples) {
            $x = [Math]::Min($ws-1,[Math]::Max(0,$s.x))
            $y = [Math]::Min($iconH-1,[Math]::Max(0,$s.y))
            # XOR stored bottom-up -> row 0 of dib = bottom row (y = iconH-1) of icon
            $rowIdxInDib = ($iconH - 1) - $y
            $rowBytes = $ws * 4
            $poff = $xorStart + $rowIdxInDib * $rowBytes + $x * 4
            $b = $raw[$poff]; $g = $raw[$poff+1]; $r = $raw[$poff+2]; $a = $raw[$poff+3]
            if ($r -gt 220 -and $r -gt $b -and ($r - $b) -gt 30) { $isOrange = $true }
            if ($b -gt 215 -and $b -ge $r -and $b -ge $g)         { $isBlue = $true }
            $sampleOut += ("{0} R={1} G={2} B={3} A={4}" -f $s.Name.PadRight(7),$r.ToString().PadLeft(3),$g.ToString().PadLeft(3),$b.ToString().PadLeft(3),$a)
        }
        $verdict = if ($isOrange) { "FAIL_ORANGE_S2" } elseif ($isBlue) { "PASS_BLUE_CENTER" } else { "PASS_WHITE_ACCEPT" }
        if ($isOrange) { $allOk = $false }
        Write-Host ("[{0,3}x{1}] biSize={2} biH*2={3} comp={4} -> {5}`n         {6}" -f $ws,$hs,$biSize,$biH_doubled,$biComp,$verdict,($sampleOut -join "  |  "))
        $entryOff += 14
    }
}
Write-Host ""
Write-Host "=== OVERALL: $(if ($allOk) {'PASS — no orange pixel found in any RT_ICON size'} else {'FAIL — orange was detected'}) ==="
exit $(if ($allOk) {0} else {1})
