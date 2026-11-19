import { hostname } from 'node:os'
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks'
import { registerOtel } from '@medusajs/medusa'
import { trace } from '@medusajs/framework/opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

// Each sample is its own root span, so the trace sampler keeps only a share of
// them; one a second leaves enough through at a 20% ratio.
const RUNTIME_SAMPLE_MS = Number(process.env.OTEL_RUNTIME_SAMPLE_MS ?? 1_000)

// One short span per interval with the process's own vital signs, so a trace
// store shows what each pod was doing while a request was slow: event-loop
// delay, garbage-collector pauses, CPU and heap. Requests record their own
// waits; this records what they were waiting behind.
function sampleRuntime() {
  if (!RUNTIME_SAMPLE_MS) {
    return
  }
  const loop = monitorEventLoopDelay({ resolution: 20 })
  loop.enable()

  let gcPauseMs = 0
  let gcCount = 0
  let gcMajorMs = 0
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcPauseMs += entry.duration
      gcCount += 1
      const kind = (entry as { detail?: { kind?: number } }).detail?.kind
      // 2 is a major (mark-sweep-compact) collection in V8's enum.
      if (kind === 2) {
        gcMajorMs += entry.duration
      }
    }
  })
  gcObserver.observe({ entryTypes: ['gc'] })

  let cpu = process.cpuUsage()
  let elu = performance.eventLoopUtilization()
  let last = Date.now()
  const host = hostname()

  const tick = () => {
    const now = Date.now()
    const elapsedMs = now - last
    const cpuNow = process.cpuUsage()
    const eluNow = performance.eventLoopUtilization()
    const memory = process.memoryUsage()
    const cpuPercent =
      ((cpuNow.user - cpu.user + cpuNow.system - cpu.system) / 1000 / elapsedMs) * 100
    const span = trace.getTracer('mercur-runtime').startSpan('runtime.sample', {
      startTime: now - 1,
      attributes: {
        'runtime.host': host,
        'runtime.pid': process.pid,
        'runtime.interval_ms': elapsedMs,
        'runtime.cpu_percent': Math.round(cpuPercent),
        'runtime.loop_utilization': Number(
          performance.eventLoopUtilization(eluNow, elu).utilization.toFixed(3)
        ),
        'runtime.loop_mean_ms': Number((loop.mean / 1e6).toFixed(1)),
        'runtime.loop_p99_ms': Number((loop.percentile(99) / 1e6).toFixed(1)),
        'runtime.loop_max_ms': Number((loop.max / 1e6).toFixed(1)),
        'runtime.gc_count': gcCount,
        'runtime.gc_pause_ms': Math.round(gcPauseMs),
        'runtime.gc_major_ms': Math.round(gcMajorMs),
        'runtime.rss_mb': Math.round(memory.rss / 1048576),
        'runtime.heap_used_mb': Math.round(memory.heapUsed / 1048576),
        'runtime.heap_total_mb': Math.round(memory.heapTotal / 1048576),
        'runtime.active_handles': (
          process as unknown as { _getActiveHandles?: () => unknown[] }
        )._getActiveHandles?.().length ?? -1,
      },
    })
    span.end(now)

    loop.reset()
    gcPauseMs = 0
    gcCount = 0
    gcMajorMs = 0
    cpu = cpuNow
    elu = eluNow
    last = now
  }

  setInterval(tick, RUNTIME_SAMPLE_MS).unref()
}

// Traces go to the OTLP/HTTP collector named by OTEL_EXPORTER_OTLP_ENDPOINT
// (for example http://<host>:4318). Without it nothing is instrumented, so a
// deployment pays for tracing only while a collector is pointed at it. Sample
// rate comes from the standard OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG
// variables, which the SDK reads itself; the runtime samples are root spans
// and so subject to the same ratio, which OTEL_RUNTIME_SAMPLE_MS=0 disables.
export function register() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return
  }

  registerOtel({
    serviceName: process.env.OTEL_SERVICE_NAME || 'mercur-api',
    exporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`,
    }),
    instrument: {
      http: true,
      workflows: true,
      query: true,
      db: true,
      cache: true,
    },
  })

  sampleRuntime()
}
