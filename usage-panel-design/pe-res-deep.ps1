$exe = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/portable/Sub2API-Usage-v3.exe"
Add-Type -AssemblyName System.Drawing

# ====== P/Invoke ======
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

public static class PE2 {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr LoadLibraryEx(string f, IntPtr hf, uint fl);
  [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr h);

  public delegate bool EnumTypesCB (IntPtr h, IntPtr type, IntPtr lp);
  public delegate bool EnumNamesCB (IntPtr h, IntPtr type, IntPtr name, IntPtr lp);
  public delegate bool EnumLangsCB (IntPtr h, IntPtr type, IntPtr name, IntPtr lang, IntPtr lp);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EnumResourceTypesW(IntPtr h, EnumTypesCB cb, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EnumResourceNamesW(IntPtr h, IntPtr type, EnumNamesCB cb, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EnumResourceLanguagesW(IntPtr h, IntPtr type, IntPtr name, EnumLangsCB cb, IntPtr lp);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr FindResourceExW(IntPtr h, IntPtr type, IntPtr name, ushort lang);
  [DllImport("kernel32.dll")] public static extern IntPtr LoadResource(IntPtr h, IntPtr r);
  [DllImport("kernel32.dll")] public static extern uint SizeofResource(IntPtr h, IntPtr r);
  [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr hr);

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHDefExtractIconW(string file, int idx, uint flags, IntPtr[] lg, IntPtr[] sm, uint nIcon);
  [DllImport("comctl32.dll")]
  public static extern int LoadIconMetric(IntPtr hi, int metrics, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
}
"@
Add-Type $src -ErrorAction SilentlyContinue

$LOAD = 2
$h = [PE2]::LoadLibraryEx($exe, [IntPtr]::Zero, $LOAD)
echo "HMODULE = $h"

echo "=== Step A: Enum ALL PE resource TYPES ==="
$typesFound = New-Object System.Collections.Generic.List[string]
$tcb = [PE2+EnumTypesCB]{
  param($mh,$tp,$lp)
  if (($tp.ToInt64() -band 0xFFFF0000) -ne 0) { $s = [Runtime.InteropServices.Marshal]::PtrToStringUni($tp) } else { $s = "ID-$($tp.ToInt32())" }
  [void]$typesFound.Add($s); return $true
}
[void][PE2]::EnumResourceTypesW($h, $tcb, [IntPtr]::Zero)
echo "resource types: $($typesFound -join ',  ')"

echo ""
echo "=== Step B: For RT_GROUP_ICON (ID-11) OR #11, enum all names, enum langs, dump GRPICONDIR ==="
$typeVals = @([IntPtr][Int16]11)
$ncb = [PE2+EnumNamesCB]{
  param($mh,$tp,$nm,$lp)
  if (($nm.ToInt64() -band 0xFFFF0000) -ne 0) { $s = [Runtime.InteropServices.Marshal]::PtrToStringUni($nm) } else { $s = "NAMEIDX-$($nm.ToInt32())" }
  echo "  RT_GROUP_ICON entry: $s"
  # now enum languages
  $lcb = [PE2+EnumLangsCB]{
    param($mh2,$tp2,$nm2,$lang,$lp2)
    echo "    lang=$lang"
    $hr = [PE2]::FindResourceExW($mh2, $tp2, $nm2, $lang)
    $sz = [PE2]::SizeofResource($mh2, $hr)
    $lres = [PE2]::LoadResource($mh2, $hr)
    $ptr = [PE2]::LockResource($lres)
    $buf = New-Object byte[] $sz
    [Runtime.InteropServices.Marshal]::Copy($ptr, $buf, 0, $sz)
    echo "    data size: $sz (first 16 bytes: $([System.BitConverter]::ToString($buf[0..15])))"
    if ($sz -ge 6) {
      $c = [BitConverter]::ToUInt16($buf, 4)
      echo "    ICONDIR count=$c"
      $off=6
      for ($j=0;$j -lt $c;$j++) {
        $w=$buf[$off]; $hh=$buf[$off+1]; $planes=[BitConverter]::ToUInt16($buf,$off+4); $bpp=[BitConverter]::ToUInt16($buf,$off+6); $bytes=[BitConverter]::ToUInt32($buf,$off+8); $rid=[BitConverter]::ToUInt16($buf,$off+12)
        echo "      [$j] ${w}x${hh} planes=$planes bpp=$bpp bytes=$bytes RT_ICON id=$rid"
        $off+=14
      }
    }
    return $true
  }
  [void][PE2]::EnumResourceLanguagesW($mh, $tp, $nm, $lcb, [IntPtr]::Zero)
  return $true
}
foreach ($t in $typeVals) { [void][PE2]::EnumResourceNamesW($h, $t, $ncb, [IntPtr]::Zero) }

# Also check all ID-3 (RT_ICON) entries — maybe there are RT_ICON entries but NO RT_GROUP_ICON directory to point them
echo ""
echo "=== Step C: Enum RT_ICON (ID-3) names (raw) ==="
$rtIconNames = New-Object System.Collections.Generic.List[string]
$ncb2 = [PE2+EnumNamesCB]{
  param($mh,$tp,$nm,$lp)
  if (($nm.ToInt64() -band 0xFFFF0000) -ne 0) { $s = [Runtime.InteropServices.Marshal]::PtrToStringUni($nm) } else { $s = "IDX-$($nm.ToInt32())" }
  [void]$rtIconNames.Add($s)
  return $true
}
[void][PE2]::EnumResourceNamesW($h, [IntPtr][Int16]3, $ncb2, [IntPtr]::Zero)
echo "RT_ICON entries: $($rtIconNames -join ', ')"

echo ""
echo "=== Step D: SHDefExtractIconW (large 256x256 if available) ==="
$large = New-Object IntPtr[] 4
$small = New-Object IntPtr[] 4
$GIL_FORCEWRITE = 0x00000800
$SHGFI_LARGEICON = 0x0
$res = [PE2]::SHDefExtractIconW($exe, 0, 0, $large, $small, 4)
echo "SHDefExtractIcon res=$res"
$outDir = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/icon-dump"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
for ($i=0; $i -lt 4; $i++) {
  foreach ($kind in @("L","S")) {
    $arr = if ($kind -eq "L") { $large } else { $small }
    if ($arr[$i] -ne [IntPtr]::Zero) {
      try {
        $ic = [System.Drawing.Icon]::FromHandle($arr[$i])
        try {
          $big = [System.Drawing.Icon]::new($ic, 256, 256)
          $bmp = $big.ToBitmap()
        } catch {
          $bmp = $ic.ToBitmap()
        }
        $path = Join-Path $outDir ("SH-{0}{1}-{2}x{3}.png" -f $kind, $i, $bmp.Width, $bmp.Height)
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $p = $bmp.GetPixel([int]($bmp.Width/2), [int]($bmp.Height/2))
        $tag = if ($p.B -gt 240 -and $p.B -gt $p.R) { "BLUE_OK" } else { "ORANGE_S2!" }
        echo "  [{0}{1}] {2}x{3} R={4} G={5} B={6} -> {7}" -f $kind,$i,$bmp.Width,$bmp.Height,$p.R,$p.G,$p.B,$tag
        $bmp.Dispose(); $ic.Dispose()
        [void][PE2]::DestroyIcon($arr[$i])
      } catch { echo "  [$kind$i] err $_" }
    }
  }
}
[void][PE2]::FreeLibrary($h)

# Also copy to user-profile top (c:\Users\...) not c:\ root (access denied)
$freshTop = Join-Path $env:USERPROFILE "BlueRadar-TOPLEVEL-20260821.exe"
Remove-Item $freshTop -Force -ErrorAction SilentlyContinue
Copy-Item $exe $freshTop -Force
$f = Get-Item $freshTop
echo ""
echo "Top-level fresh copy: $($f.FullName) bytes=$($f.Length) mtime=$($f.LastWriteTime)"
