param(
  [ValidateSet("build", "install")]
  [string]$Action = "build"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolchainRoot = Join-Path $env:LOCALAPPDATA "TorreonToolchains"
$fallbackJdk = Get-ChildItem -LiteralPath (Join-Path $toolchainRoot "jdk21") -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
$configuredJava = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME "bin\java.exe" } else { "" }

if (-not $configuredJava -or -not (Test-Path -LiteralPath $configuredJava)) {
  if (-not $fallbackJdk) { throw "Falta JDK 21. Instálalo o define JAVA_HOME." }
  $env:JAVA_HOME = $fallbackJdk.FullName
}

$fallbackSdk = Join-Path $toolchainRoot "Android\Sdk"
if (-not $env:ANDROID_HOME -or -not (Test-Path -LiteralPath $env:ANDROID_HOME)) {
  if (-not (Test-Path -LiteralPath $fallbackSdk)) { throw "Falta Android SDK. Instálalo o define ANDROID_HOME." }
  $env:ANDROID_HOME = $fallbackSdk
}
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

Push-Location $projectRoot
try {
  & npm.cmd run android:sync
  if ($LASTEXITCODE -ne 0) { throw "Falló la sincronización Android." }

  Push-Location (Join-Path $projectRoot "android")
  try {
    & .\gradlew.bat assembleDebug --no-daemon
    if ($LASTEXITCODE -ne 0) { throw "Falló la compilación de la APK." }
  } finally {
    Pop-Location
  }

  $apk = Join-Path $projectRoot "android\app\build\outputs\apk\debug\app-debug.apk"
  if (-not (Test-Path -LiteralPath $apk)) { throw "Gradle no produjo la APK esperada." }

  if ($Action -eq "install") {
    $adb = Join-Path $env:ANDROID_HOME "platform-tools\adb.exe"
    if (-not (Test-Path -LiteralPath $adb)) {
      $adb = "C:\Program Files\obs-studio\data\obs-plugins\droidcam-obs\adb\adb.exe"
    }
    if (-not (Test-Path -LiteralPath $adb)) { throw "No se encontró ADB." }
    & $adb install -r $apk
    if ($LASTEXITCODE -ne 0) { throw "ADB no pudo instalar la APK." }
    Start-Sleep -Seconds 2
    $installedPath = & $adb shell pm path com.solvecoagula.torreon
    if (-not $installedPath) {
      throw "El teléfono retiró la APK después de instalarla. Revisa el administrador o guardia de seguridad del dispositivo y autoriza com.solvecoagula.torreon."
    }
    & $adb reverse tcp:3000 tcp:3000
    if ($LASTEXITCODE -ne 0) { throw "No se pudo crear el puente ADB reverse al servidor local." }
    & $adb shell monkey -p com.solvecoagula.torreon -c android.intent.category.LAUNCHER 1
  }

  Write-Host "APK lista: $apk"
} finally {
  Pop-Location
}
