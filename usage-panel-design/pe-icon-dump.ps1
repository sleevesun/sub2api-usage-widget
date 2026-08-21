$exe = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/portable/Sub2API-Usage-v3.exe"
Add-Type -AssemblyName System.Drawing

# ---------- Icon Extractor P/Invoke ----------
$extractIconSource = @"
using System;
using System.Runtime.InteropServices;
public static class IconExtractor2026 {
  [DllImport("shell32.dll", EntryPoint = "ExtractIconExW", CharSet = CharSet.Unicode)]
  public static extern int ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr h);
}
"@
Add-Type $extractIconSource -ErrorAction SilentlyContinue

echo "=== Step 1. Count & Extract via ExtractIconEx ==="
$nSmall = [IconExtractor2026]::ExtractIconEx($exe, -1, $null, $null, 0)
echo "total icons in file: $nSmall"

$lg = New-Object IntPtr[] 16
$sm = New-Object IntPtr[] 16
$count = [IconExtractor2026]::ExtractIconEx($exe, 0, $lg, $sm, 10)
echo "extracted count: $count"

$outDir = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/icon-dump"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

for ($i = 0; $i -lt [Math]::Min($count, 10); $i++) {
  foreach ($kind in @("large", "small")) {
    $arr = if ($kind -eq "large") { $lg } else { $sm }
    if ($arr[$i] -ne [IntPtr]::Zero) {
      try {
        $ic = [System.Drawing.Icon]::FromHandle($arr[$i])
        $bmp = $ic.ToBitmap()
        $path = Join-Path $outDir ("{0}-{1}-{2}x{3}.png" -f $kind, $i, $bmp.Width, $bmp.Height)
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $p = $bmp.GetPixel([int]($bmp.Width / 2), [int]($bmp.Height / 2))
        $tag = if ($p.B -gt 240 -and $p.B -gt $p.R) { "BLUE_OK" } else { "ORANGE_FALLBACK!" }
        echo "  #$i ${kind}: $($bmp.Width)x$($bmp.Height) R=$($p.R) G=$($p.G) B=$($p.B) -> $tag"
        $bmp.Dispose(); $ic.Dispose()
        [void][IconExtractor2026]::DestroyIcon($arr[$i])
      } catch { echo "  #$i ${kind}: err $_" }
    }
  }
}

# ---------- PE RT_GROUP_ICON enumerator ----------
$peSource = @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class PE_Res {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);
  [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr h);
  public delegate bool EnumResNameProc(IntPtr h, IntPtr type, IntPtr name, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EnumResourceNamesW(IntPtr hModule, IntPtr type, EnumResNameProc cb, IntPtr lParam);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr FindResourceW(IntPtr h, IntPtr name, IntPtr type);
  [DllImport("kernel32.dll")] public static extern IntPtr LoadResource(IntPtr h, IntPtr r);
  [DllImport("kernel32.dll")] public static extern uint SizeofResource(IntPtr h, IntPtr r);
  [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr hr);
}
"@
Add-Type $peSource -ErrorAction SilentlyContinue

echo ""
echo "=== Step 2. Enumerate PE RT_GROUP_ICON (0xB) resources ==="
$LOAD_LIBRARY_AS_DATAFILE = 0x00000002
$h = [PE_Res]::LoadLibraryEx($exe, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
if ($h -eq [IntPtr]::Zero) { echo "LoadLibraryEx FAILED win32Err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }
echo "module handle: $h"

$names = New-Object System.Collections.Generic.List[string]
$cb = [PE_Res+EnumResNameProc]{
  param($mh, $tp, $nm, $lp)
  if (($nm.ToInt64() -band 0xFFFF0000) -ne 0) {
    $s = [Runtime.InteropServices.Marshal]::PtrToStringUni($nm)
  } else {
    $id = $nm.ToInt32()
    $s = "#$id"
  }
  [void]$names.Add($s)
  return $true
}
$type = [IntPtr][Int16]0xB
$ok = [PE_Res]::EnumResourceNamesW($h, $type, $cb, [IntPtr]::Zero)
echo "EnumResourceNamesW ok=$ok, groups: [$($names -join ', ')]"

foreach ($nm in $names) {
  if ($nm.StartsWith("#")) {
    $nid = [IntPtr][Int16]([int]$nm.Substring(1))
  } else {
    $nid = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($nm)
  }
  $hr = [PE_Res]::FindResourceW($h, $nid, $type)
  if ($hr -eq [IntPtr]::Zero) { echo "  find failed"; continue }
  $sz = [PE_Res]::SizeofResource($h, $hr)
  $l = [PE_Res]::LoadResource($h, $hr)
  $ptr = [PE_Res]::LockResource($l)
  $buf = New-Object byte[] $sz
  [Runtime.InteropServices.Marshal]::Copy($ptr, $buf, 0, $sz)
  echo "  group $nm size=$sz"
  $reserved = [BitConverter]::ToUInt16($buf, 0)
  $itype = [BitConverter]::ToUInt16($buf, 2)
  $entryCount = [BitConverter]::ToUInt16($buf, 4)
  echo "    icondir: res=$reserved type=$itype count=$entryCount"
  $off = 6
  for ($j = 0; $j -lt $entryCount; $j++) {
    $w = $buf[$off]; $hh = $buf[$off+1]; $bc = $buf[$off+2];
    $planes = [BitConverter]::ToUInt16($buf, $off+4)
    $bpp = [BitConverter]::ToUInt16($buf, $off+6)
    $bytes = [BitConverter]::ToUInt32($buf, $off+8)
    $rid = [BitConverter]::ToUInt16($buf, $off+12)
    echo "    [$j] ${w}x${hh} planes=$planes bpp=$bpp bytes=$bytes id=$rid"
    $off += 14
  }
}
[void][PE_Res]::FreeLibrary($h)

# ---------- Copy to C:\ root ----------
echo ""
echo "=== Step 3. Copy to C:\ root (new top-level path, zero cache hit chance) ==="
$rootNew = "C:\BlueRadar-20260821-FINAL.exe"
if (Test-Path $rootNew) { Remove-Item $rootNew -Force }
Copy-Item $exe $rootNew -Force
$f = Get-Item $rootNew
echo "Wrote: $($f.FullName) $($f.Length) bytes mtime=$($f.LastWriteTime)"
