use super::model::{Telemetry, WorkerKind, WorkerSpec};
use chrono::Utc;
#[cfg(windows)]
use std::sync::OnceLock;
use std::{process::Stdio, time::Duration};
use tokio::{process::Command, time::timeout};

const QUERY: &str = "--query-gpu=memory.total,memory.used,utilization.gpu,power.draw,power.limit,temperature.gpu,pstate";
type GpuMetrics = (u64, u64, u64, f64, f64, u64, String);
#[cfg(windows)]
static NVML_HANDLE: OnceLock<Result<usize, String>> = OnceLock::new();

fn bounded_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.kill_on_drop(true);
    command
}

pub async fn collect(worker: WorkerSpec) -> Result<Telemetry, String> {
    match worker.kind {
        WorkerKind::Local => local().await,
        WorkerKind::Remote => remote(&worker.name).await,
    }
}

async fn local() -> Result<Telemetry, String> {
    let gpu = match nvml_metrics() {
        Ok(metrics) => metrics,
        Err(_) => smi_metrics().await?,
    };
    let (plan, comfy) = tokio::join!(power_plan(), comfy_online());
    Ok(Telemetry {
        host: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "localhost".into()),
        vram_total: gpu.0,
        vram_used: gpu.1,
        utilization: gpu.2,
        power_draw: gpu.3,
        power_limit: gpu.4,
        temperature: gpu.5,
        pstate: gpu.6,
        power_plan: plan.unwrap_or_else(|_| "不明".into()),
        comfy_status: if comfy { "online" } else { "offline" }.into(),
        at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

async fn smi_metrics() -> Result<GpuMetrics, String> {
    let output = timeout(
        Duration::from_secs(3),
        bounded_command("nvidia-smi.exe")
            .arg(QUERY)
            .arg("--format=csv,noheader,nounits")
            .stdout(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| "nvidia-smi timeout".to_owned())
    .and_then(|v| v.map_err(|_| "nvidia-smi unavailable".to_owned()))?;
    parse_csv(&String::from_utf8_lossy(&output.stdout))
}
fn parse_csv(value: &str) -> Result<GpuMetrics, String> {
    let parts: Vec<_> = value.trim().split(',').map(str::trim).collect();
    if parts.len() != 7 {
        return Err("local telemetry invalid".into());
    }
    let (total, used, util, draw, limit, temp) = (
        parts[0].parse::<u64>(),
        parts[1].parse::<u64>(),
        parts[2].parse::<u64>(),
        parts[3].parse::<f64>(),
        parts[4].parse::<f64>(),
        parts[5].parse::<u64>(),
    );
    match (total, used, util, draw, limit, temp) {
        (Ok(total), Ok(used), Ok(util), Ok(draw), Ok(limit), Ok(temp))
            if used <= total && draw.is_finite() && limit.is_finite() =>
        {
            Ok((total, used, util, draw, limit, temp, parts[6].into()))
        }
        _ => Err("local telemetry invalid".into()),
    }
}
async fn power_plan() -> Result<String, String> {
    let output = timeout(
        Duration::from_secs(3),
        bounded_command("powercfg.exe")
            .arg("/getactivescheme")
            .output(),
    )
    .await
    .map_err(|_| "powercfg timeout".to_owned())
    .and_then(|v| v.map_err(|_| "powercfg unavailable".to_owned()))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let guid = text
        .split_whitespace()
        .find(|w| w.len() == 36 && w.matches('-').count() == 4)
        .unwrap_or_default()
        .to_ascii_lowercase();
    Ok(match guid.as_str() {
        "381b4222-f694-41f0-9685-ff5bb260df2e" => "バランス".into(),
        "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c" => "高パフォーマンス".into(),
        "a1841308-3541-4fab-bc81-f71556f20b4a" => "省電力".into(),
        "e9a42b02-d5df-448d-aa00-03f14749eb61" => "究極のパフォーマンス".into(),
        _ if guid.is_empty() => "不明".into(),
        _ => format!("カスタム ({})", &guid[..8]),
    })
}
async fn comfy_online() -> bool {
    reqwest::Client::new()
        .get("http://127.0.0.1:8188/system_stats")
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn remote(worker: &str) -> Result<Telemetry, String> {
    let script = "$ErrorActionPreference='Stop';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$v=(& nvidia-smi --query-gpu=memory.total,memory.used,utilization.gpu,power.draw,power.limit,temperature.gpu,pstate --format=csv,noheader,nounits)-split ',\\s*';$p=((powercfg /getactivescheme|Out-String)-replace '^.*\\((.*)\\).*$', '$1').Trim();$c='offline';try{$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8188/system_stats' -TimeoutSec 2;if($r.StatusCode -eq 200){$c='online'}}catch{};[pscustomobject]@{host=[Environment]::MachineName;vramTotal=[int]$v[0];vramUsed=[int]$v[1];utilization=[int]$v[2];powerDraw=[double]$v[3];powerLimit=[double]$v[4];temperature=[int]$v[5];pstate=$v[6];powerPlan=$p;comfyStatus=$c;at=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress";
    let command = format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        b64(&script
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect::<Vec<_>>())
    );
    let output = timeout(
        Duration::from_secs(3),
        bounded_command("ssh")
            .args([
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=2",
                worker,
                &command,
            ])
            .output(),
    )
    .await
    .map_err(|_| "ssh timeout".to_owned())
    .and_then(|v| v.map_err(|_| "ssh unavailable".to_owned()))?;
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.trim_start().starts_with("{\"host\""))
        .ok_or_else(|| "telemetry JSON missing".to_owned())?
        .trim()
        .to_owned();
    let mut data: Telemetry =
        serde_json::from_str(&line).map_err(|_| "telemetry JSON invalid".to_owned())?;
    if data.host.is_empty() {
        data.host = worker.into();
    }
    if data.vram_used > data.vram_total
        || !data.power_draw.is_finite()
        || !data.power_limit.is_finite()
        || !matches!(data.comfy_status.as_str(), "online" | "offline")
    {
        return Err("telemetry JSON invalid".into());
    }
    Ok(data)
}
fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let (a, b, d) = (c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0));
        out.push(T[(a >> 2) as usize] as char);
        out.push(T[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        out.push(if c.len() > 1 {
            T[(((b & 15) << 2) | (d >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[(d & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(windows)]
fn nvml_metrics() -> Result<GpuMetrics, String> {
    unsafe { nvml_windows() }
}
#[cfg(not(windows))]
fn nvml_metrics() -> Result<GpuMetrics, String> {
    Err("NVML unavailable".into())
}
#[cfg(windows)]
unsafe fn nvml_windows() -> Result<GpuMetrics, String> {
    use std::ffi::{CString, c_void};
    unsafe extern "system" {
        fn GetProcAddress(m: *mut c_void, p: *const i8) -> *mut c_void;
    }
    #[repr(C)]
    struct Mem {
        total: u64,
        free: u64,
        used: u64,
    }
    #[repr(C)]
    struct Util {
        gpu: u32,
        mem: u32,
    }
    type Dev = unsafe extern "C" fn(u32, *mut *mut c_void) -> i32;
    type Memory = unsafe extern "C" fn(*mut c_void, *mut Mem) -> i32;
    type Usage = unsafe extern "C" fn(*mut c_void, *mut Util) -> i32;
    type Number = unsafe extern "C" fn(*mut c_void, *mut u32) -> i32;
    let lib = nvml_handle()? as *mut c_void;
    let sym = |n: &str| -> Result<*mut c_void, String> {
        let n = CString::new(n).map_err(|_| "NVML symbol invalid".to_owned())?;
        let p = unsafe { GetProcAddress(lib, n.as_ptr()) };
        if p.is_null() {
            Err("NVML symbol unavailable".into())
        } else {
            Ok(p)
        }
    };
    let dev: Dev = unsafe { std::mem::transmute(sym("nvmlDeviceGetHandleByIndex_v2")?) };
    let mem: Memory = unsafe { std::mem::transmute(sym("nvmlDeviceGetMemoryInfo")?) };
    let util: Usage = unsafe { std::mem::transmute(sym("nvmlDeviceGetUtilizationRates")?) };
    let power: Number = unsafe { std::mem::transmute(sym("nvmlDeviceGetPowerUsage")?) };
    let limit: Number = unsafe { std::mem::transmute(sym("nvmlDeviceGetEnforcedPowerLimit")?) };
    let temp: Number = unsafe { std::mem::transmute(sym("nvmlDeviceGetTemperature")?) };
    let pstate: Number = unsafe { std::mem::transmute(sym("nvmlDeviceGetPowerState")?) };
    let mut device = std::ptr::null_mut();
    if unsafe { dev(0, &mut device) } != 0 {
        return Err("NVML device unavailable".into());
    }
    let (mut m, mut u, mut p, mut l, mut t, mut s) = (
        Mem {
            total: 0,
            free: 0,
            used: 0,
        },
        Util { gpu: 0, mem: 0 },
        0,
        0,
        0,
        0,
    );
    if unsafe { mem(device, &mut m) } != 0
        || unsafe { util(device, &mut u) } != 0
        || unsafe { power(device, &mut p) } != 0
        || unsafe { limit(device, &mut l) } != 0
        || unsafe { temp(device, &mut t) } != 0
        || unsafe { pstate(device, &mut s) } != 0
    {
        return Err("NVML query failed".into());
    }
    Ok((
        m.total / 1_048_576,
        m.used / 1_048_576,
        u.gpu as u64,
        p as f64 / 1000.,
        l as f64 / 1000.,
        t as u64,
        format!("P{s}"),
    ))
}

#[cfg(windows)]
fn nvml_handle() -> Result<usize, String> {
    NVML_HANDLE
        .get_or_init(|| unsafe {
            use std::{
                ffi::{CString, c_void},
                os::windows::ffi::OsStrExt,
            };
            unsafe extern "system" {
                fn LoadLibraryExW(p: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
                fn GetProcAddress(m: *mut c_void, p: *const i8) -> *mut c_void;
            }
            type Init = unsafe extern "C" fn() -> i32;
            const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;
            let path: Vec<u16> = std::ffi::OsStr::new("nvml.dll")
                .encode_wide()
                .chain(Some(0))
                .collect();
            let library = LoadLibraryExW(
                path.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if library.is_null() {
                return Err("NVML unavailable".into());
            }
            let symbol =
                CString::new("nvmlInit_v2").map_err(|_| "NVML symbol invalid".to_owned())?;
            let init = GetProcAddress(library, symbol.as_ptr());
            if init.is_null() {
                return Err("NVML symbol unavailable".into());
            }
            let init: Init = std::mem::transmute(init);
            if init() != 0 {
                return Err("NVML initialization failed".into());
            }
            // A process-lifetime handle keeps all cached function pointers valid; it is intentionally not unloaded.
            Ok(library as usize)
        })
        .as_ref()
        .map(|value| *value)
        .map_err(Clone::clone)
}
