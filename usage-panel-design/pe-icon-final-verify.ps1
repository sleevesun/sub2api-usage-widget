$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Drawing
$src = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class PEx {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr LoadLibraryEx(string f, IntPtr hf, uint fl);
  [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr h);
  public delegate bool EnumNamesCB(IntPtr h, IntPtr tp, IntPtr nm, IntPtr lp);
  public delegate bool EnumLangsCB(IntPtr h, IntPtr tp, IntPtr nm, IntPtr lang, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EnumResourceNamesW(IntPtr h, IntPtr type, EnumNamesCB cb, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EnumResourceLanguagesW(IntPtr h, IntPtr type, IntPtr name, EnumLangsCB cb, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr FindResourceExW(IntPtr h, IntPtr type, IntPtr name, ushort lang);
  [DllImport("kernel32.dll")] public static extern IntPtr LoadResource(IntPtr h, IntPtr r);
  [DllImport("kernel32.dll")] public static extern uint SizeofResource(IntPtr h, IntPtr r);
  [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr hr);
}
"@
Add-Type $src -ErrorAction SilentlyContinue

$exe = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/target-alt/release/sub2api-usage-widget.exe"
$LOAD = 2
$h = [PEx]::LoadLibraryEx($exe, [IntPtr]::Zero, $LOAD)
$outDir = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/icon-dump"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# ---- A. RT_GROUP_ICON (type=14) to get entry count + per size ----
$dirMap = @{}
$ncb = [PEx+EnumNamesCB]{
  param($mh,$tp,$nm,$lp)
  $lcb = [PEx+EnumLangsCB]{
    param($mh2,$tp2,$nm2,$lang,$lp2)
    $hr = [PEx]::FindResourceExW($mh2,$tp2,$nm2,([UInt16]$lang.ToInt32()))
    $sz = [PEx]::SizeofResource($mh2, $hr)
    $lr = [PEx]::LoadResource($mh2, $hr)
    $ptr = [PEx]::LockResource($lr)
    $buf = New-Object byte[] $sz
    [Runtime.InteropServices.Marshal]::Copy($ptr, $buf, 0, [int]$sz)
    $c = [BitConverter]::ToUInt16($buf,4)
    $off = 6
    for ($j=0;$j -lt $c;$j++) {
      $w = $buf[$off]; $hh=$buf[$off+1]
      if ($w -eq 0) { $w = 256 }; if ($hh -eq 0) { $hh = 256 }
      $planes=[BitConverter]::ToUInt16($buf,$off+4)
      $bpp=[BitConverter]::ToUInt16($buf,$off+6)
      $bytes=[BitConverter]::ToUInt32($buf,$off+8)
      $rid=[BitConverter]::ToUInt16($buf,$off+12)
      echo "GRP[$j] ${w}x${hh} bpp=$bpp bytes=$bytes -> RT_ICON ID=$rid"
      $script:dirMap[[int]$rid] = "${w}x${hh}_bpp${bpp}"
      $off += 14
    }
    return $true
  }
  [void][PEx]::EnumResourceLanguagesW($mh,$tp,$nm,$lcb,[IntPtr]::Zero)
  return $true
}
[void][PEx]::EnumResourceNamesW($h, [IntPtr][Int16]14, $ncb, [IntPtr]::Zero)
echo ""
echo "--- RT_ICON extraction (type=3) per entry to PNG ---"
$ncb3 = [PEx+EnumNamesCB]{
  param($mh,$tp,$nm,$lp)
  $idx = $nm.ToInt32()
  $lcb = [PEx+EnumLangsCB]{
    param($mh2,$tp2,$nm2,$lang,$lp2)
    $sz = 0
    $hr = [PEx]::FindResourceExW($mh2,$tp2,$nm2,([UInt16]$lang.ToInt32()))
    $sz = [PEx]::SizeofResource($mh2,$hr)
    $lr = [PEx]::LoadResource($mh2,$hr)
    $ptr = [PEx]::LockResource($lr)
    $buf = New-Object byte[] ([int]$sz)
    [Runtime.InteropServices.Marshal]::Copy($ptr, $buf, 0, [int]$sz)
    $sizeTag = if ($script:dirMap.ContainsKey($idx)) { $script:dirMap[$idx] } else { "size_unknown" }
    echo "RT_ICON idx=$idx ($sizeTag) raw_len=$sz first4=$([System.BitConverter]::ToString($buf[0..3]))"
    # Convert to BMP by prepending 14-byte file header
    $ms = New-Object System.IO.MemoryStream
    $wr = New-Object System.IO.BinaryWriter($ms)
    [byte[]]$bm = [byte[]]::CreateInstance([byte],14)
    $bm[0]=0x42; $bm[1]=0x4D
    $total = [UInt32](14 + $sz)
    [BitConverter]::GetBytes($total).CopyTo($bm,2)
    [BitConverter]::GetBytes([UInt32](14 + 40)).CopyTo($bm,10)
    $wr.Write($bm)
    $wr.Write($buf, 0, [int]$sz)
    $wr.Flush()
    $ms.Position = 0
    try {
      $bmp = [System.Drawing.Bitmap]::FromStream($ms)
      $pw = $bmp.Width; $ph = $bmp.Height
      $cx=[int]($pw/2); $cy=[int]($ph/2)
      $p = $bmp.GetPixel($cx,$cy)
      $tag = if ($p.B -gt 200 -and $p.B -gt $p.R) { "BLUE_OK" } elseif ($p.R -gt 200 -and $p.R -gt $p.B -and $p.G -lt $p.R) { "ORANGE_S2!!!" } else { "UNEXPECTED" }
      echo "  -> PNG dims=${pw}x${ph} center($cx,$cy) R=$($p.R) G=$($p.G) B=$($p.B) $tag"
      $path = Join-Path $script:outDir ("NEWBUILD-RTICON-{0}-{1}-{2}x{3}.png" -f $idx,$sizeTag,$pw,$ph)
      $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
    } catch { echo "  -> FromStream err: $_" }
    $wr.Dispose(); $ms.Dispose()
    return $true
  }
  [void][PEx]::EnumResourceLanguagesW($mh,$tp,$nm,$lcb,[IntPtr]::Zero)
  return $true
}
[void][PEx]::EnumResourceNamesW($h, [IntPtr][Int16]3, $ncb3, [IntPtr]::Zero)

[void][PEx]::FreeLibrary($h)

# ---- B. Copy to completely new path to defeat thumbcache path-hash ----
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
# delete again in case explorer held them
$td = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Explorer"
Get-ChildItem -Path $td -Filter "thumbcache_*.db" -Force -ErrorAction SilentlyContinue | ForEach-Object {
  try { Remove-Item $_.FullName -Force ; echo "del $($_.Name)" } catch { echo "locked: $($_.Name)" }
}
Start-Sleep -Seconds 2
Start-Process explorer.exe
Start-Sleep -Seconds 5

$portable = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/portable"
# Write as an entirely new filename INSIDE portable folder
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$newPortable = Join-Path $portable ("Sub2API-Blue-v4-$ts.exe")
Remove-Item $newPortable -Force -ErrorAction SilentlyContinue
Copy-Item $exe $newPortable -Force
# Also overwrite the old Sub2API-Usage-v3.exe
$old = Join-Path $portable "Sub2API-Usage-v3.exe"
Remove-Item $old -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Copy-Item $exe $old -Force
# AND a new path in user-profile (outside portable)
$outsideDir = Join-Path $env:USERPROFILE "dist-verification"
New-Item -ItemType Directory -Path $outsideDir -Force | Out-Null
$outsideFile = Join-Path $outsideDir ("BlueRadarCheck-${ts}.exe")
Copy-Item $exe $outsideFile -Force
$f1 = Get-Item $newPortable
$f2 = Get-Item $old
$f3 = Get-Item $outsideFile
echo ""
echo "COPIED FILES:"
echo "  new-in-portable: $($f1.Name) $($f1.Length) $($f1.LastWriteTime)"
echo "  overwrite-v3   : $($f2.Name) $($f2.Length) $($f2.LastWriteTime)"
$fn = $f3.FullName
if ($fn.Length -gt 60) { $fn = "..." + $fn.Substring($fn.Length - 55) }
echo "  outside-dir    : $fn $($f3.Length) $($f3.LastWriteTime)"
$h1 = (Get-FileHash $newPortable -Algorithm SHA256).Hash
$h2 = (Get-FileHash $old -Algorithm SHA256).Hash
$h3 = (Get-FileHash $outsideFile -Algorithm SHA256).Hash
echo "hashes match: v3=new=outside? $(($h1 -eq $h2) -and ($h2 -eq $h3))"
