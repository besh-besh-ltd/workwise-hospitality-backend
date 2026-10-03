import sdkNode from '@opentelemetry/sdk-node';
const { NodeSDK } = sdkNode;
import autoInstrumentations from '@opentelemetry/auto-instrumentations-node';
const { getNodeAutoInstrumentations } = autoInstrumentations;
import traceExporterPkg from '@opentelemetry/exporter-trace-otlp-grpc';
const { OTLPTraceExporter } = traceExporterPkg;
import metricExporterPkg from '@opentelemetry/exporter-metrics-otlp-grpc';
const { OTLPMetricExporter } = metricExporterPkg;
import logExporterPkg from '@opentelemetry/exporter-logs-otlp-grpc';
const { OTLPLogExporter } = logExporterPkg;
import sdkMetrics from '@opentelemetry/sdk-metrics';
const { PeriodicExportingMetricReader } = sdkMetrics;
import sdkLogs from '@opentelemetry/sdk-logs';
const { BatchLogRecordProcessor } = sdkLogs;
import resourcesPkg from '@opentelemetry/resources';
const { resourceFromAttributes } = resourcesPkg;
import semConv from '@opentelemetry/semantic-conventions';
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = semConv;
import { buildInstrumentationConfig, traceSamplerEnvDefaults } from './app/util/telemetryConfig.js';

// Sample 25% of new traces (parent-based, so a sampled caller keeps its whole
// trace) unless OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG are set. The SDK
// reads those standard env vars itself, so they must be in place before
// NodeSDK is constructed. Compare percentiles across this change, not counts.
Object.assign(process.env, traceSamplerEnvDefaults(process.env));

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'workwise-backend',
    [ATTR_SERVICE_VERSION]: '1.0.0',
    'deployment.environment': process.env.NODE_ENV || 'development',
  }),
  traceExporter: new OTLPTraceExporter({
    url: otlpEndpoint,
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: otlpEndpoint,
    }),
    exportIntervalMillis: 60000,
  }),
  logRecordProcessors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({ url: otlpEndpoint })
    ),
  ],
  instrumentations: [
    // Health/polling/OPTIONS ignored, express layer spans off, pg spans only
    // inside a request: see app/util/telemetryConfig.js.
    getNodeAutoInstrumentations(buildInstrumentationConfig()),
  ],
});

sdk.start();
console.log('OpenTelemetry instrumentation started');

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('OpenTelemetry SDK shut down'))
    .catch((err) => console.error('Error shutting down OTel SDK', err))
    .finally(() => process.exit(0));
});
