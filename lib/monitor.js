// Environment monitoring. "This computer" uses real OS metrics. Other machines
// (file server, NAS) are simulated in the demo; in production they'd report via a
// small agent, SNMP or WMI. Every machine keeps a rolling 5‑minute history.
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "./config.js";

const run = promisify(execFile);
const HISTORY = 100; // samples (3s apart = 5 min)
const state = new Map(); // id -> { history: [], latest }

let prevCpu = os.cpus();
function localCpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = prevCpu[i] || c;
    const t = (o) => Object.values(o.times).reduce((a, b) => a + b, 0);
    idle += c.times.idle - p.times.idle;
    total += t(c) - t(p);
  });
  prevCpu = now;
  return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0;
}

async function localDisks() {
  try {
    const { stdout } = await run("df", ["-kP"]);
    return stdout.trim().split("\n").slice(1)
      .map((l) => l.split(/\s+/))
      .filter((p) => p[0].startsWith("/dev/"))
      .filter((p) =>
        process.platform === "darwin"
          ? p[5] === "/System/Volumes/Data" || p[5].startsWith("/Volumes/") // skip sealed system & simulator volumes
          : !/^\/(boot|snap)/.test(p[5]),
      )
      .map((p) => ({ mount: p[5] === "/System/Volumes/Data" ? "Macintosh HD" : p[5].replace(/^\/Volumes\//, ""), totalGB: +(p[1] / 1048576).toFixed(1), usedGB: +(p[2] / 1048576).toFixed(1), percent: parseInt(p[4]) }))
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function localProcesses() {
  try {
    const { stdout } = await run("ps", ["-Ao", "pid=,pcpu=,pmem=,comm="]);
    return stdout.trim().split("\n").map((l) => {
      const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/);
      return m && { pid: +m[1], cpu: +m[2], mem: +m[3], name: m[4].split("/").pop() };
    }).filter(Boolean).sort((a, b) => b.cpu - a.cpu).slice(0, 6);
  } catch {
    return [];
  }
}

// macOS reports "free" memory very conservatively; use vm_stat when available.
async function localMemory() {
  const total = os.totalmem();
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("vm_stat");
      const page = +(stdout.match(/page size of (\d+)/)?.[1] || 4096);
      const g = (k) => +(stdout.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] || 0) * page;
      const used = g("Pages active") + g("Pages wired down") + g("Pages occupied by compressor");
      return { totalGB: total / 2 ** 30, usedGB: used / 2 ** 30, percent: (100 * used) / total };
    } catch {}
  }
  const used = total - os.freemem();
  return { totalGB: total / 2 ** 30, usedGB: used / 2 ** 30, percent: (100 * used) / total };
}

let slowCache = { at: 0 };
async function sampleLocal() {
  if (Date.now() - slowCache.at > 15000) {
    slowCache = { at: Date.now(), disks: await localDisks(), processes: await localProcesses() };
  }
  const mem = await localMemory();
  return {
    online: true,
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuModel: os.cpus()[0]?.model,
    cores: os.cpus().length,
    cpu: localCpuPercent(),
    load: os.loadavg(),
    memory: mem,
    disks: slowCache.disks,
    // On a shared hosting server, don't reveal other tenants' process names.
    processes: process.env.PUBLIC_MODE === "1" ? undefined : slowCache.processes,
    uptimeHours: os.uptime() / 3600,
    network: Object.entries(os.networkInterfaces()).flatMap(([n, a]) => a.filter((x) => x.family === "IPv4" && !x.internal).map((x) => ({ iface: n, ip: x.address }))),
  };
}

// --- simulated machines: smooth random walk with a daily-ish rhythm ---
const sims = new Map();
function sampleSimulated(m) {
  let s = sims.get(m.id);
  if (!s) {
    const nas = /nas/i.test(m.name);
    s = { cpu: nas ? 12 : 28, mem: nas ? 41 : 63, disk: nas ? 87.4 : 71.2, t: 0, nas };
    sims.set(m.id, s);
  }
  s.t++;
  const drift = (v, target, vol) => Math.max(2, Math.min(98, v + (target - v) * 0.08 + (Math.random() - 0.5) * vol));
  const spike = Math.random() < 0.03 ? 35 : 0;
  s.cpu = drift(s.cpu, (s.nas ? 14 : 30) + 10 * Math.sin(s.t / 20) + spike, 7);
  s.mem = drift(s.mem, s.nas ? 42 : 66, 1.5);
  const services = s.nas
    ? [
        { name: "Nightly backup – SRV01 → NAS", status: "warning", detail: "Completed with warnings: 14 files skipped (in use)" },
        { name: "Offsite cloud sync", status: "good", detail: "Last sync 02:14, 3.2 GB" },
        { name: "RAID health (SHR, 4 drives)", status: "good", detail: "Healthy" },
        { name: "Drive 3 SMART status", status: "warning", detail: "Reallocated sectors increasing (12)" },
      ]
    : [
        { name: "File sharing (SMB)", status: "good", detail: "38 open files, 9 connected users" },
        { name: "Active Directory / DNS", status: "good", detail: "Running" },
        { name: "Accounting database (Pastel/Sage)", status: "good", detail: "Running" },
        { name: "Antivirus definitions", status: "good", detail: "Updated today 06:00" },
        { name: "Windows Updates", status: "warning", detail: "3 pending updates – restart required" },
        { name: "UPS (APC 1500VA)", status: "good", detail: "On mains · battery 100% · runtime 42 min" },
      ];
  return {
    online: true,
    simulated: true,
    hostname: m.name,
    os: m.role,
    host: m.host,
    cores: s.nas ? 4 : 8,
    cpu: s.cpu,
    load: [s.cpu / 25, s.cpu / 27, s.cpu / 30],
    memory: { totalGB: s.nas ? 8 : 32, usedGB: ((s.nas ? 8 : 32) * s.mem) / 100, percent: s.mem },
    disks: s.nas
      ? [{ mount: "Volume 1 (Backups)", totalGB: 14900, usedGB: +(14900 * s.disk / 100).toFixed(0), percent: Math.round(s.disk) }]
      : [
          { mount: "C: (System)", totalGB: 476, usedGB: 214, percent: 45 },
          { mount: "D: (Projects)", totalGB: 3726, usedGB: +(3726 * s.disk / 100).toFixed(0), percent: Math.round(s.disk) },
        ],
    services,
    uptimeHours: s.nas ? 1022 : 311 + s.t / 1200,
  };
}

async function tick() {
  for (const m of getConfig().servers) {
    let sample;
    try {
      sample = m.kind === "local" ? await sampleLocal() : sampleSimulated(m);
    } catch (e) {
      sample = { online: false, error: e.message };
    }
    const st = state.get(m.id) || { history: [] };
    st.latest = { ...sample, at: Date.now() };
    st.history.push({ t: Date.now(), cpu: +(sample.cpu || 0).toFixed(1), mem: +(sample.memory?.percent || 0).toFixed(1) });
    if (st.history.length > HISTORY) st.history.shift();
    state.set(m.id, st);
  }
}

export function startMonitor() {
  // Pre-fill some history for simulated machines so charts aren't empty on first load.
  for (let i = 0; i < 40; i++) {
    for (const m of getConfig().servers.filter((x) => x.kind !== "local")) {
      const s = sampleSimulated(m);
      const st = state.get(m.id) || { history: [] };
      st.history.push({ t: Date.now() - (40 - i) * 3000, cpu: +s.cpu.toFixed(1), mem: +s.memory.percent.toFixed(1) });
      st.latest = { ...s, at: Date.now() };
      state.set(m.id, st);
    }
  }
  tick();
  setInterval(tick, 3000).unref();
}

export function alerts() {
  const out = [];
  for (const m of getConfig().servers) {
    const l = state.get(m.id)?.latest;
    if (!l) continue;
    if (!l.online) out.push({ level: "critical", machine: m.name, message: "Machine is offline / not responding" });
    if (l.cpu > 90) out.push({ level: "serious", machine: m.name, message: `CPU at ${l.cpu.toFixed(0)}%` });
    if (l.memory?.percent > 90) out.push({ level: "serious", machine: m.name, message: `Memory at ${l.memory.percent.toFixed(0)}%` });
    for (const d of l.disks || []) {
      if (d.percent >= 90) out.push({ level: "critical", machine: m.name, message: `${d.mount} is ${d.percent}% full` });
      else if (d.percent >= 85) out.push({ level: "warning", machine: m.name, message: `${d.mount} is ${d.percent}% full` });
    }
    for (const s of l.services || []) if (s.status !== "good") out.push({ level: s.status, machine: m.name, message: `${s.name}: ${s.detail}` });
  }
  return out;
}

export function snapshot() {
  return {
    machines: getConfig().servers.map((m) => ({ ...m, ...(state.get(m.id) || {}) })),
    alerts: alerts(),
  };
}

// Compact view for the AI agent (no long history arrays).
export function statusForAgent() {
  return {
    machines: getConfig().servers.map((m) => {
      const l = state.get(m.id)?.latest || {};
      const h = state.get(m.id)?.history || [];
      const avg = h.length ? h.reduce((a, b) => a + b.cpu, 0) / h.length : null;
      return {
        name: m.name, role: m.role || "Office workstation", simulated: !!l.simulated, online: l.online,
        cpuPercent: l.cpu?.toFixed(1), cpuAvg5min: avg?.toFixed(1), memoryPercent: l.memory?.percent?.toFixed(1),
        memory: l.memory && `${l.memory.usedGB.toFixed(1)} / ${l.memory.totalGB.toFixed(0)} GB`,
        disks: l.disks, services: l.services, uptimeHours: l.uptimeHours?.toFixed(0),
        topProcesses: l.processes?.slice(0, 4),
      };
    }),
    alerts: alerts(),
  };
}
