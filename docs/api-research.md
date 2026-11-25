# Windows now-playing track + LRCLIB API research

Checked **2026-11-25**. Sources are limited to Microsoft Learn/first-party Microsoft material and LRCLIB's official docs/repository. The PowerShell path below was also smoke-tested with Windows PowerShell **5.1.19041.6456**.

## 1. Windows GlobalSystemMediaTransportControlsSessionManager

### Confirmed call sequence

| Need | API | Notes |
| --- | --- | --- |
| Obtain manager | `[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()` | Returns `IAsyncOperation<GlobalSystemMediaTransportControlsSessionManager>`. Requires Windows 10 1809 / build 17763 or later. |
| Choose session | `$manager.GetCurrentSession()` or `$manager.GetSessions()` | `GetCurrentSession()` is the session Windows believes the user most likely wants to control; it is not necessarily a music-only session. Handle no current session defensively. |
| Read track metadata | `$session.TryGetMediaPropertiesAsync()` | Returns `IAsyncOperation<GlobalSystemMediaTransportControlsSessionMediaProperties>`. Useful properties: `Title`, `Artist`, `AlbumTitle`, `AlbumArtist`, `Subtitle`, `TrackNumber`, nullable `PlaybackType`. |
| Read playback state | `$session.GetPlaybackInfo()` | Synchronous. Useful properties: `PlaybackStatus`, nullable `PlaybackRate` (`1` = normal). |
| Read timeline | `$session.GetTimelineProperties()` | Synchronous. Useful properties: `Position`, `StartTime`, `EndTime`, `LastUpdatedTime`, `MinSeekTime`, `MaxSeekTime`. |
| Identify source app | `$session.SourceAppUserModelId` | Useful when multiple sessions exist or when filtering browser/video sessions. |

Sources: [manager class](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager?view=winrt-28000), [RequestAsync](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager.requestasync?view=winrt-28000), [session class](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssession?view=winrt-28000), [media properties](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmediaproperties?view=winrt-28000), [playback info](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionplaybackinfo?view=winrt-28000), [timeline properties](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessiontimelineproperties?view=winrt-28000).

### PowerShell 5.1 WinRT await pattern

Windows PowerShell 5.1 has no script-level `await`. Bridge WinRT `IAsyncOperation<T>` to a .NET `Task<T>` with `System.WindowsRuntimeSystemExtensions.AsTask`, then synchronously unwrap it. Microsoft documents `AsTask`/`GetAwaiter` in [WindowsRuntimeSystemExtensions](https://learn.microsoft.com/en-us/dotnet/api/system.windowsruntimesystemextensions?view=netframework-4.8.1).

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
    $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.GetAwaiter().GetResult()
}

# Minimum WinRT result types needed for this read path.
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session = $manager.GetCurrentSession()

if ($null -eq $session) {
    [pscustomobject]@{ hasSession = $false } | ConvertTo-Json -Compress
    return
}

$props = Await ($session.TryGetMediaPropertiesAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$playback = $session.GetPlaybackInfo()
$timeline = $session.GetTimelineProperties()
```

The smoke test confirmed that preloading only the manager and media-properties result types is sufficient to read `PlaybackInfo`, `TimelineProperties`, `PlaybackStatus`, and `PlaybackType`. Preloading those additional types is optional unless code explicitly names their types.

### Required status values

`GlobalSystemMediaTransportControlsSessionPlaybackStatus` is confirmed as:

| Value | Name | Meaning |
| ---: | --- | --- |
| 0 | `Closed` | Media closed |
| 1 | `Opened` | Media open |
| 2 | `Changing` | Media changing |
| 3 | `Stopped` | Stopped |
| 4 | `Playing` | Playing |
| 5 | `Paused` | Paused |

Source: [playback status enum](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionplaybackstatus?view=winrt-28000).

Optional media classification is `Windows.Media.MediaPlaybackType`: `Unknown=0`, `Music=1`, `Video=2`, `Image=3`. `MediaProperties.PlaybackType` is nullable. Source: [MediaPlaybackType](https://learn.microsoft.com/en-us/uwp/api/windows.media.mediaplaybacktype?view=winrt-28000).

### Lyric clock

Timeline values are `TimeSpan`; use `TotalSeconds` for fractional seconds ([Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.timespan.totalseconds?view=netframework-4.8.1)).

```text
duration = (EndTime - StartTime).TotalSeconds
basePosition = (Position - StartTime).TotalSeconds
positionNow = basePosition

if PlaybackStatus == Playing:
    positionNow += max(0, (UtcNow - LastUpdatedTime).TotalSeconds) * (PlaybackRate ?? 1)
```

`LastUpdatedTime` is UTC and `Position` is only current as of that time; `PlaybackRate` is nullable, so use `1` as the client fallback when absent. Extrapolate only while `Playing`; freeze on pause and re-read after seek, rate, status, or track changes. Clamp/reset on implausible values. Sources: [timeline properties](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessiontimelineproperties?view=winrt-28000), [LastUpdatedTime](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessiontimelineproperties.lastupdatedtime?view=winrt-28000), [PlaybackRate](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionplaybackinfo.playbackrate?view=winrt-28000).

## 2. LRCLIB API (stable v1, plus v2 beta note)

Official reference: <https://lrclib.net/docs>.

### Endpoints and parameters

| Endpoint | Parameters | Response |
| --- | --- | --- |
| `GET https://lrclib.net/api/get` | Required non-empty `track_name`, `artist_name`; optional `album_name` (recommended); optional numeric `duration` in seconds, **1–3600** | One lyrics-record object; `404 TrackNotFound` if unmatched |
| `GET https://lrclib.net/api/get/{id}` | Required numeric `id` path segment | One lyrics-record object; useful after selecting a search result |
| `GET https://lrclib.net/api/search` | At least one of `q` or `track_name`; optional `artist_name`, `album_name` | Array of full lyrics records, currently maximum 20, no pagination |
| `GET https://lrclib.net/api/v2/search` | Same search parameters | **Beta** summary objects without lyric text; fetch selected result via `/api/get/{id}` |

For `/api/get`, duration is crucial: when supplied, LRCLIB attempts a match only within approximately **±2 seconds**. URL-encode all values. Example:

```text
GET /api/get?track_name=I%20Want%20to%20Live&artist_name=Borislav%20Slavov&album_name=Baldur%27s%20Gate%203%20%28Original%20Game%20Soundtrack%29&duration=233
```

The official [live example response](https://lrclib.net/api/get/3396226) confirms the documented fields and LRC format.

### Response fields

| Field | Documented type | Meaning |
| --- | --- | --- |
| `id` | number | Stable lyrics-record ID |
| `name` | string | Backward-compatible alias of `trackName` |
| `trackName` | string | Track title |
| `artistName` | string | Artist name |
| `albumName` | string | Album name |
| `duration` | number | Track duration in seconds |
| `instrumental` | boolean | `true` means no lyrics |
| `hasWordSync` | boolean | `true` means `lyricsfile` has word-level timings (`lines[].words`) |
| `plainLyrics` | string \| null | Unsynchronized text; null for instrumental records |
| `syncedLyrics` | string \| null | LRC text with line timestamps such as `[00:17.12] ...`; null for instrumental records |
| `lyricsfile` | string | Raw Lyricsfile YAML; documented as present on every record |

Recommended selection logic:

1. If `instrumental === true`, show an instrumental state.
2. Else, if `syncedLyrics` is a non-empty string, parse and display synchronized lyrics.
3. Else, if `plainLyrics` is a non-empty string, display unsynchronized lyrics.
4. Else, show “lyrics unavailable”; `instrumental: false` does **not** guarantee lyric text exists.

`hasWordSync` does not mean `syncedLyrics` contains word timing: `syncedLyrics` remains line-level LRC. Word timing requires parsing `lyricsfile`. LRCLIB's first-party parser also shows that LRC input can contain multiple timestamps on one line, optional fractions, colon fractions, metadata tags, and untimed text: [lyricsfile.rs](https://github.com/tranxuanthang/lrclib/blob/main/core/src/lyricsfile.rs).

**Docs/source discrepancy:** the docs type `lyricsfile` as a guaranteed string, but the current public response structs model it as `Option<String>` and the architecture notes historical rows may contain `NULL`. Metadata strings are also `Option<String>` in source. Treat absent/null fields defensively. Sources: [metadata response source](https://github.com/tranxuanthang/lrclib/blob/main/server/src/routes/get_lyrics_by_metadata.rs), [ID response source](https://github.com/tranxuanthang/lrclib/blob/main/server/src/routes/get_lyrics_by_track_id.rs), [architecture/data model](https://github.com/tranxuanthang/lrclib/blob/main/ARCHITECTURE.md).

## 3. Practical Electron/Windows caveats

1. **Target Windows PowerShell 5.1 explicitly.** Prefer `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; do not assume a PATH lookup resolves to 5.1 rather than `pwsh.exe`. Use `-NoProfile -NonInteractive`. For inline code, `-EncodedCommand` avoids nested-quoting problems and expects Base64-encoded UTF-16LE. Source: [about_PowerShell_exe](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1).
2. **Return one JSON snapshot from the main process.** Set `[Console]::OutputEncoding` to UTF-8 without BOM before emitting JSON, suppress progress output, use `ConvertTo-Json -Compress`, and map failures to stderr/non-zero exit. Console output otherwise follows the system code page. Sources: [Console.OutputEncoding](https://learn.microsoft.com/en-us/dotnet/api/system.console.outputencoding?view=netframework-4.8.1), [PowerShell character encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-5.1).
3. **Session selection and metadata quality vary.** The current session may be a browser or video; `Title`/`Artist` may be blank or non-canonical. The smoke test returned `chrome.exe` with `PlaybackType=Music`. Consider `GetSessions()` plus `SourceAppUserModelId` if the product needs a specific source.
4. **Do not fetch lyrics on every position tick.** Poll/re-read the timeline for synchronization, but call LRCLIB only when the track identity or relevant metadata changes. A persistent helper can use `CurrentSessionChanged`, `SessionsChanged`, `MediaPropertiesChanged`, `PlaybackInfoChanged`, and `TimelinePropertiesChanged`; one-shot child processes cannot retain those subscriptions, so polling is the simpler fallback. Cache by normalized title/artist/album/duration and retain the returned `id`. Queue or coalesce requests during rapid track changes.
5. **Omit invalid duration.** If the timeline duration is non-finite, non-positive, or over 3600 seconds, omit `duration` rather than sending a value LRCLIB rejects. Long recordings, streams, and live media may not fit `/api/get`'s duration contract; use search as fallback.
6. **Validate matches.** Media-app metadata is not guaranteed to identify the exact recording. Check returned `trackName`, `artistName`, `albumName`, and `duration`; use `/api/search` when `/api/get` returns 404 or an implausible match. A missing track may become available later, so avoid permanent negative caching.
7. **Identify the HTTP client.** LRCLIB requires a `User-Agent` containing app name, version, and a homepage/project URL or email. Browser JavaScript may instead use `X-User-Agent` or `Lrclib-Client`; CORS is enabled. Anonymous reads need no API key. Source: [LRCLIB implementation requirements](https://lrclib.net/docs#implementation-requirements).
8. **Honor throttling.** LRCLIB asks clients to send requests sequentially, add 200–500 ms delays for batch work, and honor `Retry-After` on `429`; `503` can also include `Retry-After`. Published rate figures are approximate and not contractual. Check status and `Content-Type`: malformed-query and edge-limit responses may not be JSON. Sources: [LRCLIB rate limiting](https://lrclib.net/docs#implementation-requirements-rate-limiting), [LRCLIB errors](https://lrclib.net/docs#errors).
9. **Packaging/capability needs testing.** Microsoft lists `globalMediaControl` for these APIs and documents `<uap7:Capability Name="globalMediaControl" />` for packaged apps. Capability rules differ for unpackaged/full-trust versus AppContainer apps; an unpackaged interactive PowerShell smoke test succeeded, but that does not prove every MSIX/service context. Sources: [API requirements](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager?view=winrt-28000), [app capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations), [uap7:Capability schema](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap7-capability).
10. **Use the correct SMTC API.** This research covers the consumer-side `Windows.Media.Control` manager. Do not confuse it with provider-side `Windows.Media.SystemMediaTransportControls`, which Microsoft lists among APIs needing a desktop interop approach. Source: [WinRT desktop support](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/winrt-api-desktop-app-support).

## Uncertainty / verification limits

- No Electron wrapper was executed; verification was a direct Windows PowerShell 5.1 read of the current session plus live LRCLIB requests.
- The no-current-session branch, paused/seek/rate-change behavior, packaged Electron, service/SYSTEM, and non-interactive-session contexts were not exercised.
- LRCLIB's public repository is the self-hosted product and excludes hosted-only gateway/rate-limit components. Live hosted behavior can therefore differ from repository internals. The `lyricsfile` guarantee and nullable source types are a concrete docs/source discrepancy; defensive parsing is warranted.
