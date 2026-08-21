$exe = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/portable/Sub2API-Usage-v3.exe"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression

$src = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class PE3 {
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

  public static byte[] GetBytes(IntPtr h, IntPtr type, IntPtr name, ushort lang, out uint size) {
    IntPtr hr = FindResourceExW(h, type, name, lang);
    size = SizeofResource(h, hr);
    IntPtr lr = LoadResource(h, hr);
    IntPtr ptr = LockResource(lr);
    byte[] buf = new byte[size];
    Marshal.Copy(ptr, buf, 0, (int)size);
    return buf;
  }
}
"@
Add-Type $src -ErrorAction SilentlyContinue

$LOAD = 2
$h = [PE3]::LoadLibraryEx($exe, [IntPtr]::Zero, $LOAD)
$outDir = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/icon-dump"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

echo "=== 1. Dump RT_GROUP_ICON (type=14) ==="
$iconDirSize = 0
$iconDir = $null
$nameStr = $null
$ncb = [PE3+EnumNamesCB]{
  param($mh,$tp,$nm,$lp)
  if (($nm.ToInt64() -band 0xFFFF0000) -ne 0) { $s = [Runtime.InteropServices.Marshal]::PtrToStringUni($nm) } else { $s = "#$($nm.ToInt32())" }
  $script:nameStr = $s
  $lcb = [PE3+EnumLangsCB]{
    param($mh2,$tp2,$nm2,$lang,$lp2)
    $sz = 0
    $buf = [PE3]::GetBytes($mh2,$tp2,$nm2,$lang,[ref]$sz)
    $script:iconDirSize = [int]$sz
    $script:iconDir = $buf
    echo "group $s lang=$lang size=$sz"
    $c = [BitConverter]::ToUInt16($buf, 4)
    echo "entry count = $c"
    $off=6
    for ($j=0;$j -lt $c;$j++) {
      $w = $buf[$off]; $hh = $buf[$off+1]; $colors = $buf[$off+2]; $reserved=$buf[$off+3]
      $planes=[BitConverter]::ToUInt16($buf,$off+4)
      $bpp=[BitConverter]::ToUInt16($buf,$off+6)
      $bytes=[BitConverter]::ToUInt32($buf,$off+8)
      $rid=[BitConverter]::ToUInt16($buf,$off+12)
      echo "  [$j] w=${w} h=${hh} cols=$colors planes=$planes bpp=$bpp bytes=$bytes RT_ICON_ID=$rid"
      $off += 14
    }
    return $true
  }
  [void][PE3]::EnumResourceLanguagesW($mh, $tp, $nm, $lcb, [IntPtr]::Zero)
  return $true
}
[void][PE3]::EnumResourceNamesW($h, [IntPtr][Int16]14, $ncb, [IntPtr]::Zero)

echo ""
echo "=== 2. Dump each RT_ICON (type=3) entry -> save PNG to icon-dump folder ==="
# Build mapping from RT_ICON_ID to size using iconDir
$idToSize = @{}
if ($iconDir) {
  $c = [BitConverter]::ToUInt16($iconDir, 4); $off = 6
  for ($j=0;$j -lt $c;$j++) {
    $w = $iconDir[$off]; $hh = $iconDir[$off+1]
    $rid = [BitConverter]::ToUInt16($iconDir,$off+12)
    if ($w -eq 0) { $w = 256 }; if ($hh -eq 0) { $hh = 256 }
    $idToSize[[int]$rid] = "${w}x${hh}"
    $off += 14
  }
}
$ncb3 = [PE3+EnumNamesCB]{
  param($mh,$tp,$nm,$lp)
  $idx = $nm.ToInt32()
  $lcb = [PE3+EnumLangsCB]{
    param($mh2,$tp2,$nm2,$lang,$lp2)
    $sz = 0
    $buf = [PE3]::GetBytes($mh2,$tp2,$nm2,$lang,[ref]$sz)
    $sizeTag = if ($script:idToSize.ContainsKey($idx)) { $script:idToSize[$idx] } else { "unknown" }
    echo "RT_ICON ID=$idx size=$sizeTag raw=$sz bytes"
    # RT_ICON is a device-independent bitmap w/o BITMAPFILEHEADER (it has BITMAPINFOHEADER + pixels)
    # To make a .bmp we prepend 14-byte BITMAPFILEHEADER
    # Parse BITMAPINFOHEADER:
    $biSize = [BitConverter]::ToUInt32($buf,0)
    $biWidth = [BitConverter]::ToInt32($buf,4)
    $biHeight = [BitConverter]::ToInt32($buf,8)  # can be negative or positive; positive = bottom-up, double = AND mask + XOR mask
    $biPlanes = [BitConverter]::ToUInt16($buf,12)
    $biBitCount = [BitConverter]::ToUInt16($buf,14)
    $biCompression = [BitConverter]::ToUInt32($buf,16)
    echo "  BITMAPINFO: biSize=$biSize w=$biWidth h=$biHeight planes=$biPlanes bpp=$biBitCount compression=$biCompression"
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $fileHeader = New-Object byte[] 14
    $fileHeader[0]=0x42; $fileHeader[1]=0x4D  # BM
    $totalSize = 14 + $sz
    [BitConverter]::GetBytes([uint32]$totalSize).CopyTo($fileHeader,2)
    [BitConverter]::GetBytes([uint32](14 + 40)).CopyTo($fileHeader,10)  # pixel data offset (basic)
    $bw.Write($fileHeader)
    $bw.Write($buf, 0, [int]$sz)
    $bw.Flush()
    $ms.Position = 0
    try {
      $bmp = [System.Drawing.Bitmap]::FromStream($ms)
      $w2 = $bmp.Width; $h2 = $bmp.Height
      $path = Join-Path $script:outDir ("PE-RTICON-{0}-{1}-{2}x{3}.png" -f $idx,$sizeTag,$w2,$h2)
      $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      $p = $bmp.GetPixel([int]($w2/2),[int]($h2/2))
      $tag = if ($p.B -gt 200 -and $p.B -gt $p.R) { "BLUE_OK" } elseif ($p.R -gt 200 -and $p.R -gt $p.B -and $p.G -gt 100 -and $p.G -lt $p.R) { "ORANGE_S2!!!" } else { "NEED_CHECK" }
      echo "  saved PNG: $path ; center pixel R=$($p.R) G=$($p.G) B=$($p.B) -> $tag"
      $bmp.Dispose()
    } catch { echo "  BMP save err: $_" }
    $bw.Dispose(); $ms.Dispose()
    return $true
  }
  [void][PE3]::EnumResourceLanguagesW($mh,$tp,$nm,$lcb,[IntPtr]::Zero)
  return $true
}
[void][PE3]::EnumResourceNamesW($h, [IntPtr][Int16]3, $ncb3, [IntPtr]::Zero)

[void][PE3]::FreeLibrary($h)

echo ""
echo "=== 3. Also compare target-alt/release exe (build artifact) ==="
$targetExe = "c:/Users/sunxian125927/Documents/sub2api/usage-panel-design/target-alt/release/sub2api-usage-widget.exe"
$fe = Get-Item $exe; $ft = Get-Item $targetExe
echo "portable: $($fe.Length) bytes $($fe.LastWriteTime)"
echo "buildout: $($ft.Length) bytes $($ft.LastWriteTime)"
$hp = (Get-FileHash $exe -Algorithm SHA256).Hash
$ht = (Get-FileHash $targetExe -Algorithm SHA256).Hash
echo "hash match = $($hp -eq $ht)"
