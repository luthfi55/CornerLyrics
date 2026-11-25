param([switch]$Once)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } |
        Select-Object -First 1

    function Await-WinRT {
        param($WinRtTask, [Type]$ResultType)

        $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
        return $netTask.GetAwaiter().GetResult()
    }

    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

    $managerTask = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
    $manager = Await-WinRT $managerTask ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    do {
        $session = $manager.GetCurrentSession()
        if ($null -eq $session) {
            [pscustomobject]@{
                playing = $false
                title = ''
                artist = ''
                album = ''
                source = ''
                position = 0
                duration = 0
                rate = 1
                updated = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            } | ConvertTo-Json -Compress
        }
        else {
            $propertiesTask = $session.TryGetMediaPropertiesAsync()
            $properties = Await-WinRT $propertiesTask ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $playback = $session.GetPlaybackInfo()
            $timeline = $session.GetTimelineProperties()
            $isPlaying = ([string]$playback.PlaybackStatus -eq 'Playing')

            $durationMs = [Math]::Round(($timeline.EndTime - $timeline.StartTime).TotalMilliseconds)
            if ($durationMs -lt 0) { $durationMs = 0 }

            $positionMs = [Math]::Round(($timeline.Position - $timeline.StartTime).TotalMilliseconds)
            if ($positionMs -lt 0) { $positionMs = 0 }

            $rate = 1.0
            if ($null -ne $playback.PlaybackRate) {
                $rate = [double]$playback.PlaybackRate
            }

            if ($isPlaying -and $rate -gt 0) {
                $elapsedSeconds = ([DateTimeOffset]::UtcNow - $timeline.LastUpdatedTime).TotalSeconds
                if ($elapsedSeconds -gt 0) {
                    $positionMs += [Math]::Round($elapsedSeconds * 1000 * $rate)
                }
            }

            if ($durationMs -gt 0 -and $positionMs -gt $durationMs) {
                $positionMs = $durationMs
            }

            $artist = [string]$properties.Artist
            if ([string]::IsNullOrWhiteSpace($artist)) {
                $artist = [string]$properties.AlbumArtist
            }

            [pscustomobject]@{
                playing = $isPlaying
                title = [string]$properties.Title
                artist = $artist
                album = [string]$properties.AlbumTitle
                source = [string]$session.SourceAppUserModelId
                position = [int]$positionMs
                duration = [int][Math]::Round($durationMs / 1000)
                rate = $rate
                updated = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            } | ConvertTo-Json -Compress
        }

        if ($Once) { break }
        Start-Sleep -Milliseconds 750
    } while ($true)
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
