param(
  [Parameter(Mandatory = $true)][string]$InputDir,
  [string]$Pattern = 'frame-*.jpg',
  [string]$Locale = 'fr-CA',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'

function Write-Result([object]$Result) {
  if ($OutFile) {
    $Result | ConvertTo-Json -Depth 10 -Compress | Out-File -FilePath $OutFile -Encoding utf8 -NoNewline
    Write-Output "OK $OutFile"
  }
  else {
    $Result | ConvertTo-Json -Depth 10 -Compress
  }
}

$engine = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

  function AwaitOperation($Op, [Type]$ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($Op))
    if (-not $netTask.Wait(300000)) { throw 'await timed out' }
    $netTask.Result
  }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Locale))
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { throw 'no Windows OCR engine available' }

  $files = Get-ChildItem -Path $InputDir -File -Filter $Pattern | Sort-Object Name
  $results = @()

  foreach ($file in $files) {
    $resultObj = $null
    try {
      $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
      $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
      try {
        $writer.WriteBytes($bytes)
        AwaitOperation ($writer.StoreAsync()) ([uint32]) | Out-Null
        AwaitOperation ($writer.FlushAsync()) ([bool]) | Out-Null
        $stream.Seek(0)
        $decoder = AwaitOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = AwaitOperation ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $ocrResult = AwaitOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

        $lines = @()
        foreach ($line in $ocrResult.Lines) {
          $words = @()
          foreach ($word in $line.Words) {
            $words += [pscustomobject]@{
              text = $word.Text
              x = [math]::Round($word.BoundingRect.X, 1)
              y = [math]::Round($word.BoundingRect.Y, 1)
              w = [math]::Round($word.BoundingRect.Width, 1)
              h = [math]::Round($word.BoundingRect.Height, 1)
            }
          }
          $lines += [pscustomobject]@{ text = $line.Text; words = $words }
        }
        $resultObj = [pscustomobject]@{ image = $file.Name; text = $ocrResult.Text; lines = $lines }
      }
      finally {
        if ($writer) { $writer.Dispose() }
        if ($stream) { $stream.Dispose() }
      }
    }
    catch {
      $resultObj = [pscustomobject]@{ image = $file.Name; error = $_.Exception.Message }
    }
    $results += $resultObj
  }

  Write-Result ([pscustomobject]@{
    engine = 'windows-ocr'
    locale = $engine.RecognizerLanguage.LanguageTag
    count = $results.Count
    results = $results
  })
}
catch {
  Write-Result ([pscustomobject]@{ error = $_.Exception.Message })
  exit 1
}