param(
  [string]$ConfigPath = ".\sub2api_usage_config.json",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

function Get-NestedValue {
  param(
    [Parameter(Mandatory = $true)] $Object,
    [Parameter(Mandatory = $true)] [string] $Path
  )

  $current = $Object
  foreach ($part in $Path.Split(".")) {
    if ($null -eq $current) { return $null }
    $property = $current.PSObject.Properties[$part]
    if ($null -eq $property) { return $null }
    $current = $property.Value
  }
  return $current
}

function Get-FirstValue {
  param($Primary, $Fallback)
  if ($null -ne $Primary -and "$Primary" -ne "") { return $Primary }
  return $Fallback
}

function Mask-Key {
  param([string]$Key)
  if ($Key.Length -le 12) { return "***" }
  return "$($Key.Substring(0, 7))...$($Key.Substring($Key.Length - 6))"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $config.base_url) { throw "config.base_url is required" }
if (-not $config.keys -or $config.keys.Count -eq 0) { throw "config.keys must be a non-empty array" }

if (-not $OutputDir) {
  if ($config.output_dir) { $OutputDir = [string]$config.output_dir } else { $OutputDir = "." }
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$baseUrl = ([string]$config.base_url).TrimEnd("/")
$usageUrl = "$baseUrl/v1/usage"
$collectedAt = (Get-Date).ToUniversalTime().ToString("o")
$jsonlPath = Join-Path $OutputDir "usage_snapshots.jsonl"
$csvPath = Join-Path $OutputDir "usage_summary.csv"
$rows = New-Object System.Collections.Generic.List[object]
$failures = 0

foreach ($item in $config.keys) {
  $apiKey = [string]$item.key
  $name = [string]$item.name
  if (-not $name) { $name = Mask-Key $apiKey }
  if (-not $apiKey) {
    Write-Warning "skip ${name}: missing key"
    $failures += 1
    continue
  }

  try {
    $usage = Invoke-RestMethod -Uri $usageUrl -Method Get -Headers @{
      Authorization = "Bearer $apiKey"
      Accept = "application/json"
      "User-Agent" = "sub2api-usage-collector/1.0"
    } -TimeoutSec 30

    $snapshot = [pscustomobject]@{
      collected_at = $collectedAt
      key_name = $name
      usage = $usage
    }
    ($snapshot | ConvertTo-Json -Depth 50 -Compress) | Add-Content -LiteralPath $jsonlPath -Encoding UTF8

    $quota = $usage.quota
    $subscription = $usage.subscription
    $total = Get-NestedValue $usage "usage.total"
    $today = Get-NestedValue $usage "usage.today"

    $row = [pscustomobject]@{
      collected_at = $collectedAt
      key_name = $name
      is_valid = (Get-FirstValue $usage.isValid $usage.is_active)
      mode = $usage.mode
      status = $usage.status
      unit = (Get-FirstValue $usage.unit $quota.unit)
      quota_limit = $quota.limit
      quota_used = $quota.used
      quota_remaining = (Get-FirstValue $quota.remaining $usage.remaining)
      balance = $usage.balance
      daily_limit_usd = $subscription.daily_limit_usd
      daily_usage_usd = $subscription.daily_usage_usd
      weekly_limit_usd = $subscription.weekly_limit_usd
      weekly_usage_usd = $subscription.weekly_usage_usd
      monthly_limit_usd = $subscription.monthly_limit_usd
      monthly_usage_usd = $subscription.monthly_usage_usd
      total_requests = $total.requests
      total_tokens = $total.total_tokens
      total_actual_cost = $total.actual_cost
      today_requests = $today.requests
      today_tokens = $today.total_tokens
      today_actual_cost = $today.actual_cost
      rpm = (Get-NestedValue $usage "usage.rpm")
      tpm = (Get-NestedValue $usage "usage.tpm")
    }
    $rows.Add($row) | Out-Null
    Write-Host "[OK] ${name}: status=$($usage.status) remaining=$($row.quota_remaining)"
  } catch {
    $failures += 1
    $snapshot = [pscustomobject]@{
      collected_at = $collectedAt
      key_name = $name
      error = $_.Exception.Message
    }
    ($snapshot | ConvertTo-Json -Depth 20 -Compress) | Add-Content -LiteralPath $jsonlPath -Encoding UTF8
    Write-Error "[ERROR] ${name}: $($_.Exception.Message)" -ErrorAction Continue
  }
}

if ($rows.Count -gt 0) {
  if (Test-Path -LiteralPath $csvPath) {
    $rows | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Append -Encoding UTF8
  } else {
    $rows | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8
  }
}

if ($failures -gt 0) { exit 1 }
