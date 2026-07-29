[CmdletBinding()]
param(
    [switch]$Local
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SqlPath = Join-Path $PSScriptRoot "product-metrics.sql"
$Wrangler = Join-Path $RepoRoot "node_modules\.bin\wrangler.cmd"
$Target = if ($Local) { "--local" } else { "--remote" }
$Sql = (Get-Content $SqlPath) -join " "

$Output = & $Wrangler d1 execute aikagi-ban $Target --json --command $Sql
if ($LASTEXITCODE -ne 0) {
    throw "D1 metrics query failed with exit code $LASTEXITCODE"
}

$Payload = ($Output -join [Environment]::NewLine) | ConvertFrom-Json
$Row = $Payload[0].results[0]
if (-not $Row) {
    throw "D1 metrics query returned no result"
}

function Get-Percent {
    param([int]$Numerator, [int]$Denominator)
    if ($Denominator -eq 0) { return $null }
    return [Math]::Round(($Numerator / $Denominator) * 100, 1)
}

$Users = [int]$Row.users
$Creators = [int]$Row.creators
$Openers = [int]$Row.openers
$Contributors = [Math]::Max([int]$Row.posters, [int]$Row.commenters)

[ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    service = "aikagi-ban"
    environment = if ($Local) { "local" } else { "production" }
    funnel = [ordered]@{
        users = $Users
        creators = $Creators
        openers = $Openers
        posters = [int]$Row.posters
        commenters = [int]$Row.commenters
        acknowledgers = [int]$Row.acknowledgers
        photo_users = [int]$Row.photo_users
        exporters = [int]$Row.exporters
        returned = [int]$Row.returned
        boards_created_7d = [int]$Row.boards_created_7d
        boards_opened_7d = [int]$Row.boards_opened_7d
    }
    inventory = [ordered]@{
        active_boards = [int]$Row.active_boards
        posts = [int]$Row.posts
        comments = [int]$Row.comments
        acknowledgements = [int]$Row.acknowledgements
    }
    rates = [ordered]@{
        create_percent = Get-Percent $Creators $Users
        open_percent = Get-Percent $Openers $Users
        contribute_percent = Get-Percent $Contributors $Openers
        acknowledge_percent = Get-Percent ([int]$Row.acknowledgers) $Openers
    }
} | ConvertTo-Json -Depth 4
