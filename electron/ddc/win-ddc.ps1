param(
  [string]$Action = "list",
  [int]$Index = 0,
  [uint32]$Value = 0,
  [string]$Plan = ""
)

# Read/write monitor VCP 0x60 (input source) through DXVA2 (dxva2.dll).
# No third-party tool required. Keep this file ASCII-only: PowerShell 5.1
# mis-decodes non-ASCII comments when the file has no BOM.

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

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

    // Enumerate ONCE, then apply every value on those cached handles.
    // Re-enumerating between writes breaks multi-monitor switching: as soon as
    // the first monitor leaves this PC's input, Windows drops it from
    // EnumDisplayMonitors and the remaining indexes shift, so the second
    // monitor either gets skipped or gets the wrong value.
    public static string SetPlan(string plan)
    {
        Dictionary<int, uint> map = new Dictionary<int, uint>();
        foreach (string pair in plan.Split(';'))
        {
            if (pair == null || pair.Length == 0) continue;
            string[] kv = pair.Split('=');
            if (kv.Length != 2) continue;
            int idx;
            uint val;
            if (!int.TryParse(kv[0], out idx)) continue;
            if (!uint.TryParse(kv[1], out val)) continue;
            map[idx] = val;
        }

        List<PHYSICAL_MONITOR> l = Enum();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < l.Count; i++)
        {
            uint v;
            if (!map.TryGetValue(i, out v))
            {
                sb.Append("MON=" + i + "|SKIP|0\n");
                continue;
            }
            bool ok = SetVCPFeature(l[i].hPhysicalMonitor, 0x60, v);
            int code = 0;
            if (!ok) code = Marshal.GetLastWin32Error();
            sb.Append("MON=" + i + "|" + (ok ? "True" : "False") + "|" + code + "\n");
        }
        return sb.ToString();
    }

    public static string SetAll(uint val)
    {
        List<PHYSICAL_MONITOR> l = Enum();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < l.Count; i++)
        {
            bool ok = SetVCPFeature(l[i].hPhysicalMonitor, 0x60, val);
            int code = 0;
            if (!ok) code = Marshal.GetLastWin32Error();
            sb.Append("MON=" + i + "|" + (ok ? "True" : "False") + "|" + code + "\n");
        }
        return sb.ToString();
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
  "setall" {
    # Switch every physical monitor to the same input in a single process,
    # so we only pay the Add-Type compile cost once.
    Write-Output ("COUNT=" + [SsDdc]::Count())
    Write-Output ([SsDdc]::SetAll($Value))
  }
  "setplan" {
    # Per-monitor values in one process. Plan format: "0=17;1=18"
    # (index=decimal VCP value). Used when each monitor sits on a different port.
    Write-Output ("COUNT=" + [SsDdc]::Count())
    Write-Output ([SsDdc]::SetPlan($Plan))
  }
  default { Write-Output "ERR=unknown-action" }
}
