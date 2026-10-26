param(
  [string]$Action = "list",
  [int]$Index = 0,
  [uint32]$Value = 0
)

# Read/write monitor VCP 0x60 (input source) through DXVA2 (dxva2.dll).
# No third-party tool required. Keep this file ASCII-only: PowerShell 5.1
# mis-decodes non-ASCII comments when the file has no BOM.

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class SsDdc
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PHYSICAL_MONITOR
    {
        public IntPtr hPhysicalMonitor;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szPhysicalMonitorDescription;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, ref uint pdwNumberOfPhysicalMonitors);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint dwPhysicalMonitorArraySize, [Out] PHYSICAL_MONITOR[] pPhysicalMonitorArray);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool SetVCPFeature(IntPtr hMonitor, byte bVCPCode, uint dwNewValue);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr hMonitor, byte bVCPCode, IntPtr pvct, ref uint pdwCurrentValue, ref uint pdwMaximumValue);

    public static List<PHYSICAL_MONITOR> Enum()
    {
        List<PHYSICAL_MONITOR> result = new List<PHYSICAL_MONITOR>();
        MonitorEnumProc cb = delegate(IntPtr hMonitor, IntPtr hdc, ref RECT r, IntPtr d)
        {
            uint count = 0;
            if (GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, ref count) && count > 0)
            {
                PHYSICAL_MONITOR[] arr = new PHYSICAL_MONITOR[count];
                if (GetPhysicalMonitorsFromHMONITOR(hMonitor, count, arr))
                {
                    foreach (PHYSICAL_MONITOR m in arr) result.Add(m);
                }
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        return result;
    }

    public static int Count() { return Enum().Count; }

    public static string NameAt(int i)
    {
        List<PHYSICAL_MONITOR> l = Enum();
        if (i < 0 || i >= l.Count) return "";
        return l[i].szPhysicalMonitorDescription == null ? "" : l[i].szPhysicalMonitorDescription;
    }

    public static bool SetVcp(int i, byte code, uint val)
    {
        List<PHYSICAL_MONITOR> l = Enum();
        if (i < 0 || i >= l.Count) return false;
        return SetVCPFeature(l[i].hPhysicalMonitor, code, val);
    }

    public static int GetVcp(int i, byte code)
    {
        List<PHYSICAL_MONITOR> l = Enum();
        if (i < 0 || i >= l.Count) return -1;
        uint cur = 0, max = 0;
        if (GetVCPFeatureAndVCPFeatureReply(l[i].hPhysicalMonitor, code, IntPtr.Zero, ref cur, ref max))
            return (int)cur;
        return -1;
    }
}
"@ -ErrorAction Stop

switch ($Action) {
  "list" {
    $n = [SsDdc]::Count()
    Write-Output ("COUNT=" + $n)
    for ($i = 0; $i -lt $n; $i++) {
      $name = [SsDdc]::NameAt($i)
      $cur = [SsDdc]::GetVcp($i, 0x60)
      $hex = if ($cur -ge 0) { "0x" + ("{0:x}" -f $cur) } else { "" }
      Write-Output ("MON=" + $i + "|" + $name + "|" + $hex)
    }
  }
  "set" {
    $ok = [SsDdc]::SetVcp($Index, 0x60, $Value)
    Write-Output ("SET=" + $ok + "|INDEX=" + $Index + "|VALUE=0x" + ("{0:x}" -f $Value))
    if (-not $ok) {
      $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Write-Output ("ERR=" + $code)
    }
  }
  default { Write-Output "ERR=unknown-action" }
}
