param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$DragDx = 0,
  [int]$DragDy = 0
)

$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy;
    public uint mouseData; public uint dwFlags; public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public MOUSEINPUT mi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT p);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT p);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);

  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

  public static void MoveTo(int x, int y) {
    int sx = GetSystemMetrics(16);
    int sy = GetSystemMetrics(17);
    var mv = new INPUT { type = 0 };
    mv.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
    mv.mi.dx = (x * 65535 + (sx / 2)) / Math.Max(1, sx - 1);
    mv.mi.dy = (y * 65535 + (sy / 2)) / Math.Max(1, sy - 1);
    SendInput(1, new INPUT[] { mv }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Glide(int fromX, int fromY, int dx, int dy, int steps) {
    for (int i = 1; i <= steps; i++) {
      MoveTo(fromX + (dx * i / steps), fromY + (dy * i / steps));
      System.Threading.Thread.Sleep(30);
    }
  }

  public static void GlideRelative(int totalDx, int totalDy, int steps) {
    for (int i = 0; i < steps; i++) {
      var mv = new INPUT { type = 0 };
      mv.mi.dwFlags = MOUSEEVENTF_MOVE;
      mv.mi.dx = totalDx / steps;
      mv.mi.dy = totalDy / steps;
      SendInput(1, new INPUT[] { mv }, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(30);
    }
  }
  public const uint WM_NCHITTEST = 0x0084;

  public static void Click() {
    var down = new INPUT { type = 0 };
    down.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    var up = new INPUT { type = 0 };
    up.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(1, new INPUT[] { down }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(120);
    SendInput(1, new INPUT[] { up }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Press() {
    var down = new INPUT { type = 0 };
    down.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    SendInput(1, new INPUT[] { down }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Release() {
    var up = new INPUT { type = 0 };
    up.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(1, new INPUT[] { up }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static string Describe(IntPtr hwnd) {
    var rect = new RECT();
    GetWindowRect(hwnd, out rect);
    var sb = new StringBuilder(256);
    GetClassName(hwnd, sb, 256);
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    return "hwnd=" + hwnd + " class=" + sb.ToString() + " pid=" + pid + " iconic=" + IsIconic(hwnd)
      + " rect=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom;
  }
}
'@
Add-Type -TypeDefinition $code

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4): coordinate APIs operate on true physical pixels
$oldCtx = [NativeInput]::SetThreadDpiAwarenessContext([IntPtr](-4))
Write-Output "DPI_CONTEXT_OLD=$oldCtx"
Write-Output "SCREEN=$([NativeInput]::GetSystemMetrics(0))x$([NativeInput]::GetSystemMetrics(1))"

$before = New-Object NativeInput+POINT
[NativeInput]::GetCursorPos([ref]$before) | Out-Null
try {
  $ok = [NativeInput]::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 80

  $pt = New-Object NativeInput+POINT
  [NativeInput]::GetCursorPos([ref]$pt) | Out-Null
  Write-Output "SET_CURSOR ok=$ok actual=$($pt.X),$($pt.Y)"
  $hwnd = [NativeInput]::WindowFromPoint($pt)
  $under = [NativeInput]::Describe($hwnd)
  $lparam = ($pt.Y -shl 16) -bor ($pt.X -band 0xFFFF)
  $ht = [NativeInput]::SendMessage($hwnd, [NativeInput]::WM_NCHITTEST, [IntPtr]::Zero, [IntPtr]$lparam)
  Write-Output "UNDER_CURSOR $under"
  Write-Output "HITTEST=$ht (1=client 2=caption 17=topright-resize)"

  if ($DragDx -ne 0 -or $DragDy -ne 0) {
    Write-Output "NATIVE_DRAG dx=$DragDx dy=$DragDy"
    [NativeInput]::Press()
    Start-Sleep -Milliseconds 400
    [NativeInput]::GlideRelative($DragDx, $DragDy, 10)
    Start-Sleep -Milliseconds 200
    [NativeInput]::Release()
  } else {
    [NativeInput]::Click()
  }
  Start-Sleep -Milliseconds 80
} finally {
  [NativeInput]::SetCursorPos($before.X, $before.Y) | Out-Null
}
Write-Output "NATIVE_CLICK_DONE x=$X y=$Y drag=$DragDx,$DragDy"
