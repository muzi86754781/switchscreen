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
using System.Threading;

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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceString;
        public uint StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceKey;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, ref uint pdwNumberOfPhysicalMonitors);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint dwPhysicalMonitorArraySize, [Out] PHYSICAL_MONITOR[] pPhysicalMonitorArray);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool SetVCPFeature(IntPtr hMonitor, byte bVCPCode, uint dwNewValue);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr hMonitor, byte bVCPCode, IntPtr pvct, ref uint pdwCurrentValue, ref uint pdwMaximumValue);

    // One physical monitor: DDC handle + DXVA2 description + the GDI device
    // (\\.\DISPLAY1) and its friendly model name (e.g. "DELL U2414H").
    // The friendly name is what makes index<->model mapping exact: DXVA2 often
    // reports every monitor as "Generic PnP Monitor", and WMI order is not the
    // same as the enumeration order used below.
    public class SsMon
    {
        public PHYSICAL_MONITOR pm;
        public string device;
        public string hwid;
        public SsMon(PHYSICAL_MONITOR p, string d, string h) { pm = p; device = d; hwid = h; }
    }

    public class Job
    {
        public int index;
        public IntPtr handle;
        public string desc;
        public uint value;
        public bool done;
        public int code;
        public Job(int i, IntPtr h, string d, uint v)
        {
            index = i; handle = h; desc = d; value = v; done = false; code = 0;
        }
    }

    // Hardware id of the panel behind a monitor, e.g. "MONITOR\DELA0A4\{...}\0004".
    // Its middle segment (DELA0A4) is exactly what WmiMonitorID.InstanceName carries,
    // so JS can join the two and get the real model name per enumeration index.
    // (DeviceString is useless here: Windows reports "Generic PnP Monitor".)
    static string HwIdOf(IntPtr hMonitor)
    {
        MONITORINFOEX mi = new MONITORINFOEX();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (!GetMonitorInfo(hMonitor, ref mi)) return "";
        if (mi.szDevice == null || mi.szDevice.Length == 0) return "";
        DISPLAY_DEVICE dd = new DISPLAY_DEVICE();
        dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        if (!EnumDisplayDevices(mi.szDevice, 0, ref dd, 0)) return "";
        return dd.DeviceID == null ? "" : dd.DeviceID.Trim();
    }

    static string DeviceOf(IntPtr hMonitor)
    {
        MONITORINFOEX mi = new MONITORINFOEX();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (!GetMonitorInfo(hMonitor, ref mi)) return "";
        return mi.szDevice == null ? "" : mi.szDevice;
    }

    public static List<SsMon> Enum()
    {
        List<SsMon> result = new List<SsMon>();
        MonitorEnumProc cb = delegate(IntPtr hMonitor, IntPtr hdc, ref RECT r, IntPtr d)
        {
            uint count = 0;
            if (GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, ref count) && count > 0)
            {
                PHYSICAL_MONITOR[] arr = new PHYSICAL_MONITOR[count];
                if (GetPhysicalMonitorsFromHMONITOR(hMonitor, count, arr))
                {
                    string dev = DeviceOf(hMonitor);
                    string hwid = HwIdOf(hMonitor);
                    foreach (PHYSICAL_MONITOR m in arr) result.Add(new SsMon(m, dev, hwid));
                }
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        return result;
    }

    public static string Desc(PHYSICAL_MONITOR m)
    {
        return m.szPhysicalMonitorDescription == null ? "" : m.szPhysicalMonitorDescription;
    }

    public static bool Same(string a, string b)
    {
        if (a == null || b == null) return false;
        string x = a.Trim().ToLowerInvariant();
        string y = b.Trim().ToLowerInvariant();
        if (x.Length == 0 || y.Length == 0) return false;
        return x == y || x.Contains(y) || y.Contains(x);
    }

    // Enumerate once and read name + current input for every physical monitor.
    // Format: MON=index|dxva2 desc|current input|gdi device|hardware id
    public static string ListAll()
    {
        List<SsMon> l = Enum();
        StringBuilder sb = new StringBuilder();
        sb.Append("COUNT=" + l.Count + "\n");
        for (int i = 0; i < l.Count; i++)
        {
            uint cur = 0, max = 0;
            bool ok = GetVCPFeatureAndVCPFeatureReply(l[i].pm.hPhysicalMonitor, 0x60, IntPtr.Zero, ref cur, ref max);
            string hex = ok ? ("0x" + cur.ToString("x")) : "";
            sb.Append("MON=" + i + "|" + Desc(l[i].pm) + "|" + hex + "|" + l[i].device + "|" + l[i].hwid + "\n");
        }
        return sb.ToString();
    }

    static Dictionary<int, uint> ParsePlan(string plan)
    {
        Dictionary<int, uint> map = new Dictionary<int, uint>();
        string s = plan == null ? "" : plan;
        foreach (string pair in s.Split(';'))
        {
            if (pair == null || pair.Length == 0) continue;
            string[] kv = pair.Split('=');
            if (kv.Length != 2) continue;
            uint v;
            if (!uint.TryParse(kv[1], out v)) continue;
            if (kv[0] == "*") { map[-1] = v; continue; }
            int idx;
            if (!int.TryParse(kv[0], out idx)) continue;
            map[idx] = v;
        }
        return map;
    }

    static bool Pick(Dictionary<int, uint> map, int i, out uint v)
    {
        if (map.ContainsKey(i)) { v = map[i]; return true; }
        if (map.ContainsKey(-1)) { v = map[-1]; return true; }
        v = 0;
        return false;
    }

    // Fire every write at the same moment.
    // Sequential writes fail on multi-monitor setups: as soon as the first
    // monitor leaves this PC's input, Windows rebuilds the display topology
    // and the handles of the remaining monitors become invalid, so the second
    // (and later) writes silently do nothing.
    static void Fire(List<Job> pending, bool[] okRes, int[] codes)
    {
        ManualResetEvent go = new ManualResetEvent(false);
        Thread[] ts = new Thread[pending.Count];
        for (int k = 0; k < pending.Count; k++)
        {
            int kk = k;
            IntPtr h = pending[kk].handle;
            uint v = pending[kk].value;
            ts[kk] = new Thread(delegate()
            {
                go.WaitOne();
                uint cur = 0, max = 0;
                if (GetVCPFeatureAndVCPFeatureReply(h, 0x60, IntPtr.Zero, ref cur, ref max))
                {
                    if (cur == v)
                    {
                        okRes[kk] = true;
                        codes[kk] = 0;
                        return;
                    }
                }
                bool r = SetVCPFeature(h, 0x60, v);
                okRes[kk] = r;
                if (!r) codes[kk] = Marshal.GetLastWin32Error();
            });
            ts[kk].IsBackground = true;
            ts[kk].Start();
        }
        go.Set();
        for (int k = 0; k < ts.Length; k++) ts[k].Join(6000);
    }

    // Pick the slot in 'pool' that belongs to 'desc' and remove it from the pool.
    static int TakeBest(List<SsMon> pool, string desc)
    {
        if (pool.Count == 0) return -1;
        if (desc == null || desc.Length == 0) return 0;
        int hit = -1;
        for (int i = 0; i < pool.Count; i++)
        {
            if (Same(Desc(pool[i].pm), desc)) { hit = i; break; }
        }
        return hit;
    }

    // plan: "0=17;1=18" (index=decimal VCP value) or "*=17" (every monitor).
    public static string SetPlan(string plan)
    {
        Dictionary<int, uint> map = ParsePlan(plan);
        List<SsMon> all = Enum();
        List<Job> jobs = new List<Job>();
        List<int> missing = new List<int>();

        for (int i = 0; i < all.Count; i++)
        {
            uint v;
            if (!Pick(map, i, out v)) continue;
            uint cur = 0, max = 0;
            if (GetVCPFeatureAndVCPFeatureReply(all[i].pm.hPhysicalMonitor, 0x60, IntPtr.Zero, ref cur, ref max))
            {
                if (cur == v)
                {
                    Job j = new Job(i, all[i].pm.hPhysicalMonitor, Desc(all[i].pm), v);
                    j.done = true;
                    jobs.Add(j);
                    continue;
                }
            }
            jobs.Add(new Job(i, all[i].pm.hPhysicalMonitor, Desc(all[i].pm), v));
        }
        foreach (int key in map.Keys)
        {
            if (key < 0) continue;
            if (key >= all.Count) missing.Add(key);
        }

        for (int round = 0; round < 4; round++)
        {
            List<Job> pending = new List<Job>();
            for (int k = 0; k < jobs.Count; k++) if (!jobs[k].done) pending.Add(jobs[k]);
            if (pending.Count == 0) break;
            if (round > 0) Thread.Sleep(round == 1 ? 450 : 800);

            bool[] okRes = new bool[pending.Count];
            int[] codes = new int[pending.Count];
            Fire(pending, okRes, codes);
            for (int k = 0; k < pending.Count; k++)
            {
                if (okRes[k]) { pending[k].done = true; pending[k].code = 0; }
                else pending[k].code = codes[k];
            }
            if (round == 3) break;

            // Re-enumerate: a monitor that really switched away is gone from
            // the list (its picture no longer comes from this PC). Anything
            // still listed did not switch -> retry on a fresh handle.
            Thread.Sleep(320);
            List<SsMon> fresh = Enum();
            for (int k = 0; k < pending.Count; k++)
            {
                Job j = pending[k];
                if (j.done) continue;
                int hit = TakeBest(fresh, j.desc);
                if (hit < 0) { j.done = true; j.code = 0; continue; }

                // Already on the wanted input? Do not write again: every write
                // makes the monitor re-sync its signal (that 1-3s black screen).
                uint cur = 0, max = 0;
                bool readOk = GetVCPFeatureAndVCPFeatureReply(
                    fresh[hit].pm.hPhysicalMonitor, 0x60, IntPtr.Zero, ref cur, ref max);
                if (readOk && cur == j.value)
                {
                    j.done = true;
                    j.code = 0;
                    continue;
                }

                j.handle = fresh[hit].pm.hPhysicalMonitor; fresh.RemoveAt(hit);
            }
        }

        StringBuilder sb = new StringBuilder();
        sb.Append("COUNT=" + all.Count + "\n");
        for (int k = 0; k < jobs.Count; k++)
        {
            sb.Append("MON=" + jobs[k].index + "|" + (jobs[k].done ? "True" : "False") + "|" + jobs[k].code + "\n");
        }
        for (int k = 0; k < missing.Count; k++)
        {
            sb.Append("MON=" + missing[k] + "|GONE|0\n");
        }
        return sb.ToString();
    }
}
"@ -ErrorAction Stop

switch ($Action) {
  "list" {
    Write-Output ([SsDdc]::ListAll())
  }
  "set" {
    Write-Output ([SsDdc]::SetPlan("$Index=$Value"))
  }
  "setall" {
    Write-Output ([SsDdc]::SetPlan("*=$Value"))
  }
  "setplan" {
    Write-Output ([SsDdc]::SetPlan($Plan))
  }
  default { Write-Output "ERR=unknown-action" }
}
