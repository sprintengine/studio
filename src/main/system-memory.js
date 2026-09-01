import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
// OS-wide memory is what actually predicts system exhaustion across Multicode,
// other apps, and the OS. getAppMetrics only sees Electron's own processes, so
// the panel needs this separate availability estimate. Sampled on a throttle off
// the hot path, mirroring thread-counts / child-process-metrics.
export const SYSTEM_MEMORY_SAMPLE_THROTTLE_MS = 5_000;
// macOS `vm_stat` prints "(page size of 16384 bytes)" then "Key: value." lines
// in pages. We approximate *available* memory as the pages the kernel can hand
// out without paging (free + speculative + inactive + purgeable) and treat the
// rest as an estimated non-reclaimable amount. `utilizationRatio` is simply
// 1 - available/total; it is not macOS memory pressure. Compressor + swap are
// carried raw as separate context. Returns null when the output is unparseable
// so the caller falls back to the os-module reading.
export function parseDarwinVmStat(vmStat, swapUsage, totalBytes) {
    const pageSizeMatch = vmStat.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
    const pages = (label) => {
        const match = vmStat.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
        return match ? Number(match[1]) : 0;
    };
    const free = pages('Pages free');
    const speculative = pages('Pages speculative');
    const inactive = pages('Pages inactive');
    const purgeable = pages('Pages purgeable');
    const compressed = pages('Pages occupied by compressor');
    if (free === 0 && inactive === 0 && compressed === 0)
        return null;
    const availableBytes = (free + speculative + inactive + purgeable) * pageSize;
    const compressedBytes = compressed * pageSize;
    const swapUsedBytes = parseSwapUsedBytes(swapUsage);
    const clampedAvailable = Math.min(availableBytes, totalBytes);
    return {
        totalBytes,
        availableBytes: clampedAvailable,
        usedBytes: Math.max(0, totalBytes - clampedAvailable),
        compressedBytes,
        swapUsedBytes,
        utilizationRatio: totalBytes > 0 ? clamp01(1 - clampedAvailable / totalBytes) : 0,
        source: 'vm_stat',
    };
}
// `sysctl vm.swapusage` / `vm_stat`-adjacent output: "... used = 1357.62M ...".
function parseSwapUsedBytes(swapUsage) {
    const match = swapUsage.match(/used\s*=\s*([\d.]+)([KMGT]?)/i);
    if (!match)
        return 0;
    return scaleSuffix(Number(match[1]), match[2]);
}
// Linux `/proc/meminfo`: "MemAvailable: 1234 kB". Prefer MemAvailable (kernel's
// own estimate); fall back to MemFree when absent.
export function parseLinuxMemInfo(memInfo, totalBytes) {
    const kb = (label) => {
        const match = memInfo.match(new RegExp(`${label}:\\s+(\\d+)\\s*kB`));
        return match ? Number(match[1]) * 1024 : null;
    };
    const available = kb('MemAvailable') ?? kb('MemFree');
    if (available === null)
        return null;
    const swapTotal = kb('SwapTotal') ?? 0;
    const swapFree = kb('SwapFree') ?? 0;
    const clampedAvailable = Math.min(available, totalBytes);
    return {
        totalBytes,
        availableBytes: clampedAvailable,
        usedBytes: Math.max(0, totalBytes - clampedAvailable),
        compressedBytes: 0,
        swapUsedBytes: Math.max(0, swapTotal - swapFree),
        utilizationRatio: totalBytes > 0 ? clamp01(1 - clampedAvailable / totalBytes) : 0,
        source: 'proc',
    };
}
// Cross-platform floor: os.freemem() is always available. On macOS it
// undercounts "available" (it excludes reclaimable cache), so it's only the
// fallback when vm_stat parsing fails.
function osMemorySample(totalBytes) {
    const available = Math.min(freemem(), totalBytes);
    return {
        totalBytes,
        availableBytes: available,
        usedBytes: Math.max(0, totalBytes - available),
        compressedBytes: 0,
        swapUsedBytes: 0,
        utilizationRatio: totalBytes > 0 ? clamp01(1 - available / totalBytes) : 0,
        source: 'os',
    };
}
function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}
function scaleSuffix(value, suffix) {
    const factor = suffix === 'K' || suffix === 'k' ? 1024
        : suffix === 'M' || suffix === 'm' ? 1024 ** 2
            : suffix === 'G' || suffix === 'g' ? 1024 ** 3
                : suffix === 'T' || suffix === 't' ? 1024 ** 4
                    : 1;
    return Math.round(value * factor);
}
export async function sampleSystemMemory(deps = {}) {
    const platform = deps.platform ?? process.platform;
    const totalBytes = deps.totalBytes ?? totalmem();
    try {
        if (platform === 'darwin') {
            const runVmStat = deps.runVmStat ?? (() => execFileText('vm_stat', []));
            const runSwapUsage = deps.runSwapUsage ?? (() => execFileText('sysctl', ['-n', 'vm.swapusage']));
            const [vmStat, swapUsage] = await Promise.all([runVmStat(), runSwapUsage()]);
            const parsed = parseDarwinVmStat(vmStat, swapUsage, totalBytes);
            if (parsed)
                return parsed;
        }
        else if (platform === 'linux') {
            const readMemInfo = deps.readMemInfo ?? (() => readFile('/proc/meminfo', 'utf8').catch(() => ''));
            const parsed = parseLinuxMemInfo(await readMemInfo(), totalBytes);
            if (parsed)
                return parsed;
        }
    }
    catch {
        // Fall through to the os-module reading.
    }
    return osMemorySample(totalBytes);
}
function execFileText(command, args) {
    return new Promise((resolve) => {
        execFile(command, args, { timeout: 2_000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? '' : stdout));
    });
}
