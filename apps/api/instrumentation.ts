import { registerOtel } from '@medusajs/medusa'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

// Traces go to the OTLP/HTTP collector named by OTEL_EXPORTER_OTLP_ENDPOINT
// (for example http://<host>:4318). Without it nothing is instrumented, so a
// deployment pays for tracing only while a collector is pointed at it. Sample
// rate comes from the standard OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG
// variables, which the SDK reads itself.
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
}
