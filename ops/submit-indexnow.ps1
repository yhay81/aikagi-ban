[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern("^https://")]
    [string]$BaseUrl
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PublicDirectory = Join-Path $RepoRoot "public"
$NormalizedBaseUrl = $BaseUrl.TrimEnd("/")
$KeyFiles = @(
    Get-ChildItem -LiteralPath $PublicDirectory -File |
        Where-Object { $_.Name -match "^[a-zA-Z0-9-]{8,128}\.txt$" }
)

if ($KeyFiles.Count -ne 1) {
    throw "Expected exactly one IndexNow key file in public, found $($KeyFiles.Count)"
}

$Key = (Get-Content -Raw -LiteralPath $KeyFiles[0].FullName).Trim()
if ($Key -ne $KeyFiles[0].BaseName) {
    throw "IndexNow key file name and content do not match"
}

function Invoke-PublishedGet {
    param([Parameter(Mandatory)][string]$Uri)
    for ($Attempt = 1; $Attempt -le 5; $Attempt++) {
        try {
            $Result = Invoke-WebRequest -Uri $Uri -SkipHttpErrorCheck -TimeoutSec 20
            if ($Result.StatusCode -eq 200) { return $Result }
        }
        catch {
            if ($Attempt -eq 5) { throw }
        }
        if ($Attempt -lt 5) { Start-Sleep -Seconds $Attempt }
    }
    throw "Published resource did not return HTTP 200 after retries: $Uri"
}

$KeyLocation = "$NormalizedBaseUrl/$Key.txt"
$KeyResponse = Invoke-PublishedGet -Uri $KeyLocation
if ($KeyResponse.Content.Trim() -ne $Key) {
    throw "Published IndexNow key file is unavailable or mismatched"
}

$SitemapResponse = Invoke-PublishedGet -Uri "$NormalizedBaseUrl/sitemap.xml"
[xml]$Sitemap = $SitemapResponse.Content
$Urls = @($Sitemap.urlset.url.loc | ForEach-Object { [string]$_ })
if ($Urls.Count -eq 0) { throw "Published sitemap contains no URLs" }

$Payload = @{
    host = ([uri]$NormalizedBaseUrl).Host
    key = $Key
    keyLocation = $KeyLocation
    urlList = $Urls
} | ConvertTo-Json -Depth 3

$Response = Invoke-WebRequest `
    -Uri "https://api.indexnow.org/indexnow" `
    -Method Post `
    -ContentType "application/json; charset=utf-8" `
    -Body $Payload `
    -SkipHttpErrorCheck `
    -TimeoutSec 30

if ($Response.StatusCode -notin @(200, 202)) {
    throw "IndexNow submission failed with HTTP $($Response.StatusCode): $($Response.Content)"
}

[ordered]@{
    submitted_at = (Get-Date).ToUniversalTime().ToString("o")
    service = ([uri]$NormalizedBaseUrl).Host
    status = [int]$Response.StatusCode
    url_count = $Urls.Count
    urls = $Urls
} | ConvertTo-Json -Depth 3
