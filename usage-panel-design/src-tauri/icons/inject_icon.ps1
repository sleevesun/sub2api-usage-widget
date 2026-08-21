Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Res {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr BeginUpdateResourceW(string pFileName, bool bDeleteExistingResources);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wIDLanguage, IntPtr lpData, int cbData);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
}
"@

$exePath = "c:\Users\sunxian125927\Documents\sub2api\usage-panel-design\target-alt\release\sub2api-usage-widget.exe"
$icoPath = "c:\Users\sunxian125927\Documents\sub2api\usage-panel-design\src-tauri\icons\icon.ico"

if (-not (Test-Path $exePath)) { Write-Host "ERROR: exe not found at $exePath"; exit 1 }
if (-not (Test-Path $icoPath)) { Write-Host "ERROR: ico not found at $icoPath"; exit 1 }

Write-Host "Injecting icon into: $exePath"
Write-Host "Using icon: $icoPath"

$icoBytes = [System.IO.File]::ReadAllBytes($icoPath)
Write-Host "Icon size: $($icoBytes.Length) bytes"

$ms = [System.IO.MemoryStream]::new($icoBytes)
$br = [System.IO.BinaryReader]::new($ms)
$reserved = $br.ReadUInt16()
$type = $br.ReadUInt16()
$count = $br.ReadUInt16()
Write-Host "Icon contains $count images"

$entries = @()
$dirSize = 6 + (16 * $count)
for ($i = 0; $i -lt $count; $i++) {
    $e = [pscustomobject]@{
        w = $br.ReadByte(); h = $br.ReadByte(); colors = $br.ReadByte(); reserved2 = $br.ReadByte()
        planes = $br.ReadUInt16(); bpp = $br.ReadUInt16(); size = $br.ReadUInt32(); offset = $br.ReadUInt32()
    }
    $entries += $e
}

# Read RT_GROUP_ICON data (dir + entries)
$ms.Position = 0
$groupData = $br.ReadBytes($dirSize)

# Read individual image data
$images = @()
foreach ($e in $entries) {
    $ms.Position = $e.offset
    $imgData = $br.ReadBytes($e.size)
    $images += ,$imgData
}
$br.Close()
$ms.Close()

Write-Host "RT_GROUP_ICON size: $dirSize"
Write-Host "Images: $($images.Count)"

# Open exe for resource update
$hUpdate = [Win32Res]::BeginUpdateResourceW($exePath, $true)
if ($hUpdate -eq [IntPtr]::Zero) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Host "ERROR BeginUpdateResource: Win32Error=$err"
    exit 1
}
Write-Host "BeginUpdateResource OK"

# Write RT_GROUP_ICON (type=14, name=1)
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($groupData.Length)
[System.Runtime.InteropServices.Marshal]::Copy($groupData, 0, $ptr, $groupData.Length)
$ok = [Win32Res]::UpdateResource($hUpdate, [IntPtr]::new(14), [IntPtr]::new(1), 0, $ptr, $groupData.Length)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
if (-not $ok) { Write-Host "ERROR UpdateResource GROUP_ICON: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; [Win32Res]::EndUpdateResource($hUpdate, $true) | Out-Null; exit 1 }
Write-Host "RT_GROUP_ICON written OK"

# Write RT_ICON images
for ($i = 0; $i -lt $images.Count; $i++) {
    $imgId = 100 + $i
    $img = $images[$i]
    $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($img.Length)
    [System.Runtime.InteropServices.Marshal]::Copy($img, 0, $ptr, $img.Length)
    $ok = [Win32Res]::UpdateResource($hUpdate, [IntPtr]::new(3), [IntPtr]::new($imgId), 0, $ptr, $img.Length)
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
    if (-not $ok) { Write-Host "ERROR RT_ICON[$imgId]: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; [Win32Res]::EndUpdateResource($hUpdate, $true) | Out-Null; exit 1 }
    Write-Host "  RT_ICON[$imgId] written ($($img.Length) bytes)"
}

$ok = [Win32Res]::EndUpdateResource($hUpdate, $false)
if (-not $ok) { Write-Host "ERROR EndUpdateResource: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }

$fi = Get-Item $exePath
Write-Host "SUCCESS! New exe size: $($fi.Length) bytes"
