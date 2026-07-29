[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkerPath = Join-Path $RepoRoot "src\worker.tsx"
$MigrationPath = Join-Path $RepoRoot "migrations\0001_boards.sql"
$AppPath = Join-Path $RepoRoot "public\app.js"
$BoardPath = Join-Path $RepoRoot "public\board.js"
$StylesPath = Join-Path $RepoRoot "public\styles.css"
$PublicDirectory = Join-Path $RepoRoot "public"

$RequiredFiles = @(
    ".github\workflows\ci.yml",
    "DECISIONS.md",
    "EXPERIMENT.md",
    "METRICS.md",
    "PRIVACY.md",
    "README.md",
    "SECURITY.md",
    "STACK.md",
    "ops\product-metrics.ps1",
    "ops\product-metrics.sql",
    "ops\submit-indexnow.ps1",
    "public\app.js",
    "public\board.js",
    "public\favicon.svg",
    "public\manifest.webmanifest",
    "public\styles.css",
    "public\og.svg",
    "public\robots.txt",
    "public\sitemap.xml"
)
foreach ($RelativePath in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $RelativePath))) {
        throw "Missing required release file: $RelativePath"
    }
}

$Worker = Get-Content -Raw -LiteralPath $WorkerPath
$Migration = Get-Content -Raw -LiteralPath $MigrationPath
$App = Get-Content -Raw -LiteralPath $AppPath
$Board = Get-Content -Raw -LiteralPath $BoardPath
$Styles = Get-Content -Raw -LiteralPath $StylesPath
$ProductSurface = @($Worker, $App, $Board) -join "`n"

if (-not $Worker.Contains('class="board-scene"') -or
    -not $Worker.Contains('class="sample-card notice"') -or
    -not $Worker.Contains('class="message-board"') -or
    -not $Worker.Contains('class="privacy-flow"')) {
    throw "Expected the visual board scene, cards, private board, and privacy flow"
}
if ($ProductSurface -match '(?i)public validation|success criteria|experiment|仮説|成功条件|市場スコア|移行候補|収益性') {
    throw "Research copy must not appear on the product surface"
}
if ($Styles -match '(?s)h1\s*\{[^}]*font-size:\s*(?:[4-9]\d|[1-9]\d{2})px') {
    throw "Primary heading is too large"
}
if ($Board -match '(?i)innerHTML|eval\(|new Function') {
    throw "Board content must not be interpreted as markup or code"
}
if (-not $App.Contains('fetch("/api/events"') -or
    -not $App.Contains('fetch("/api/boards"') -or
    -not $Board.Contains("createImageBitmap") -or
    -not $Board.Contains("canvas.toBlob") -or
    -not $Board.Contains("680_000") -or
    -not $Board.Contains('data-action="copy-manage"')) {
    throw "Expected bounded board APIs, client image reduction, and a recoverable organizer URL"
}
if (-not $Board.Contains("#key=") -or
    -not $Board.Contains("&manage=") -or
    -not $Worker.Contains("await sha256(accessToken)") -or
    -not $Worker.Contains("await sha256(organizerToken)")) {
    throw "Expected fragment-only raw keys and hashed stored capabilities"
}
if (-not $Worker.Contains("enforceSameOrigin") -or
    -not $Worker.Contains("30 * 86400") -or
    -not $Worker.Contains("45 * 86400") -or
    -not $Worker.Contains("maximumPhotoBytes = 700_000") -or
    -not $Worker.Contains("deletePhotoPrefix")) {
    throw "Expected same-origin writes and bounded board, photo, and event retention"
}
if ($Migration -match '(?i)\b(email|phone|ip_address|user_agent)\b') {
    throw "Direct contact and request identifiers do not belong in stored board data or telemetry"
}
if (-not $Migration.Contains("ON DELETE CASCADE") -or
    -not $Migration.Contains("is_qa") -or
    -not $Migration.Contains("CHECK(name IN")) {
    throw "Expected cascading deletion, allowlisted events, and a QA boundary"
}
if ($Worker -match '(?i)better-auth|betterAuth') {
    throw "Account authentication is not needed for this capability-link release"
}

$OgPath = Join-Path $PublicDirectory "og.svg"
if ((Get-Item -LiteralPath $OgPath).Length -lt 2500) {
    throw "Expected a product-specific OG SVG larger than 2.5 KB"
}

$KeyFiles = @(
    Get-ChildItem -LiteralPath $PublicDirectory -File |
        Where-Object { $_.Name -match "^[a-zA-Z0-9-]{8,128}\.txt$" }
)
if ($KeyFiles.Count -ne 1) {
    throw "Expected exactly one generated IndexNow key file, found $($KeyFiles.Count)"
}
$Key = (Get-Content -Raw -LiteralPath $KeyFiles[0].FullName).Trim()
if ($Key -ne $KeyFiles[0].BaseName) {
    throw "IndexNow key file name and content do not match"
}

Write-Output "Product release contract is satisfied"
