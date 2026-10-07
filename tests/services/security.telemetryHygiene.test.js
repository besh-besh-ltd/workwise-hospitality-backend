// SECURITY / PERF — telemetry hygiene.
// ----------------------------------------------------------------------------
// 1. bodyCapture exported every JSON response body to traces UNSANITIZED
//    (login tokens, PII) and re-serialised every response just to measure it.
//    Now: response capture is opt-in (LOG_RESPONSE_BODY=true), sanitised when
//    on, and a body over the cap is skipped without a second stringify.
// 2. The pure config helpers behind otel-instrument.mjs and the access log:
//    which requests get no trace/log line, the default sampler, and the
//    instrumentation options.
//
// bodyCapture is driven through a real Express app with a real (recording)
// span in the active OTel context, the way the http instrumentation supplies
// it in production.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { trace, context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import bodyCapture, { bodyCaptureSettings } from "../../app/middleware/bodyCapture.js";
import {
  NOISY_ROUTES,
  isNoisyRoute,
  shouldIgnoreIncomingRequest,
  traceSamplerEnvDefaults,
  buildInstrumentationConfig,
} from "../../app/util/telemetryConfig.js";

const savedEnv = {
  LOG_RESPONSE_BODY: process.env.LOG_RESPONSE_BODY,
  MAX_BODY_LOG_SIZE: process.env.MAX_BODY_LOG_SIZE,
};
let contextManager;

beforeAll(() => {
  contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
});

afterAll(() => {
  context.disable();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  jest.restoreAllMocks();
});

/** A span that records its attributes, standing in for the http server span. */
function recordingSpan() {
  const attributes = {};
  const span = trace.wrapSpanContext({
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: 1,
  });
  span.setAttribute = (k, v) => {
    attributes[k] = v;
    return span;
  };
  return { span, attributes };
}

const LOGIN_RESPONSE = {
  status: 1,
  message: "Login successful",
  token: "eyJhbGciOiJIUzI1NiJ9.secret-jwt",
  data: { id: 42, email: "buyer@example.com", access_token: "also-secret" },
};

function appRespondingWith(body, captured) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const { span, attributes } = recordingSpan();
    captured.attributes = attributes;
    context.with(trace.setSpan(context.active(), span), next);
  });
  app.use(bodyCapture);
  app.post("/thing", (req, res) => res.json(body));
  return app;
}

describe("bodyCapture: response bodies", () => {
  it("does not capture response bodies by default", async () => {
    delete process.env.LOG_RESPONSE_BODY;
    const captured = {};
    const res = await request(appRespondingWith(LOGIN_RESPONSE, captured))
      .post("/thing")
      .send({ email: "buyer@example.com", password: "hunter2" });
    expect(res.body).toEqual(LOGIN_RESPONSE);
    expect(captured.attributes["http.response.body"]).toBeUndefined();
    expect(JSON.stringify(captured.attributes)).not.toMatch(/secret-jwt|also-secret/);
    // Request bodies are still captured, sanitised.
    expect(captured.attributes["http.request.body"]).toMatch(/\[REDACTED\]/);
    expect(captured.attributes["http.request.body"]).not.toMatch(/hunter2/);
  });

  it("when opted in, captures the response sanitised (tokens redacted)", async () => {
    process.env.LOG_RESPONSE_BODY = "true";
    const captured = {};
    const res = await request(appRespondingWith(LOGIN_RESPONSE, captured)).post("/thing").send({});
    expect(res.body).toEqual(LOGIN_RESPONSE);
    const exported = captured.attributes["http.response.body"];
    expect(exported).toBeDefined();
    expect(exported).toMatch(/Login successful/);
    expect(exported).not.toMatch(/secret-jwt|also-secret/);
    expect(JSON.parse(exported).token).toBe("[REDACTED]");
  });

  it("skips a body over the cap and stringifies it only once (express's own)", async () => {
    process.env.LOG_RESPONSE_BODY = "true";
    process.env.MAX_BODY_LOG_SIZE = "1024";
    const big = { status: 1, data: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `row ${i}` })) };
    const captured = {};
    const app = appRespondingWith(big, captured);
    const spy = jest.spyOn(JSON, "stringify");
    const res = await request(app).post("/thing").send({});
    const callsWithBig = spy.mock.calls.filter(([v]) => v === big).length;
    spy.mockRestore();
    expect(res.body.data).toHaveLength(500);
    expect(callsWithBig).toBe(1);
    expect(captured.attributes["http.response.body"]).toBeUndefined();
    expect(captured.attributes["http.response.body.truncated"]).toBe(true);
    expect(captured.attributes["http.response.body.size"]).toBeGreaterThan(1024);
  });

  it("settings: response capture is opt-in only", () => {
    expect(bodyCaptureSettings({}).logResponseBody).toBe(false);
    expect(bodyCaptureSettings({ LOG_RESPONSE_BODY: "1" }).logResponseBody).toBe(false);
    expect(bodyCaptureSettings({ LOG_RESPONSE_BODY: "true" }).logResponseBody).toBe(true);
    expect(bodyCaptureSettings({}).logRequestBody).toBe(true);
    expect(bodyCaptureSettings({ LOG_REQUEST_BODY: "false" }).logRequestBody).toBe(false);
  });
});

describe("telemetryConfig", () => {
  it("treats health and the two polling routes as noisy, with or without a query", () => {
    for (const r of NOISY_ROUTES) {
      expect(isNoisyRoute(r)).toBe(true);
      expect(isNoisyRoute(`${r}?_=123`)).toBe(true);
      expect(isNoisyRoute(`${r}/`)).toBe(true);
    }
    expect(isNoisyRoute("/api/v1/general/hospitality/approval/pending/counts")).toBe(true);
    expect(isNoisyRoute("/api/v1/users/notifications/unread-count")).toBe(true);
    expect(isNoisyRoute("/api/v1/rfq/list-view")).toBe(false);
    expect(isNoisyRoute("/api/v1/users/notifications")).toBe(false);
    expect(isNoisyRoute("/healthz")).toBe(false);
  });

  it("ignores incoming OPTIONS and noisy routes, traces everything else", () => {
    expect(shouldIgnoreIncomingRequest({ method: "OPTIONS", url: "/api/v1/rfq/list-view" })).toBe(true);
    expect(shouldIgnoreIncomingRequest({ method: "GET", url: "/api/health" })).toBe(true);
    expect(shouldIgnoreIncomingRequest({ method: "GET", url: "/health" })).toBe(true);
    expect(
      shouldIgnoreIncomingRequest({ method: "GET", url: "/api/v1/users/notifications/unread-count?x=1" })
    ).toBe(true);
    expect(shouldIgnoreIncomingRequest({ method: "POST", url: "/api/v1/rfq/list-view" })).toBe(false);
    expect(shouldIgnoreIncomingRequest({ method: "GET", url: "/api/v1/po/12" })).toBe(false);
  });

  it("defaults the sampler to parentbased_traceidratio 0.25 only when unset", () => {
    expect(traceSamplerEnvDefaults({})).toEqual({
      OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
      OTEL_TRACES_SAMPLER_ARG: "0.25",
    });
    expect(traceSamplerEnvDefaults({ OTEL_TRACES_SAMPLER: "always_on" })).toEqual({});
    expect(
      traceSamplerEnvDefaults({ OTEL_TRACES_SAMPLER: "parentbased_traceidratio", OTEL_TRACES_SAMPLER_ARG: "0.1" })
    ).toEqual({});
    expect(traceSamplerEnvDefaults({ OTEL_TRACES_SAMPLER_ARG: "0.5" })).toEqual({
      OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
    });
  });

  it("configures http ignore hook, express layer filter and pg parent requirement", () => {
    const cfg = buildInstrumentationConfig();
    expect(cfg["@opentelemetry/instrumentation-http"].ignoreIncomingRequestHook).toBe(
      shouldIgnoreIncomingRequest
    );
    expect(cfg["@opentelemetry/instrumentation-express"].ignoreLayersType).toEqual([
      "middleware",
      "request_handler",
    ]);
    expect(cfg["@opentelemetry/instrumentation-pg"].requireParentSpan).toBe(true);
    expect(cfg["@opentelemetry/instrumentation-fs"].enabled).toBe(false);
  });
});
