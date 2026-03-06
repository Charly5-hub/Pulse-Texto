import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { after, before } from "node:test";

const require = createRequire(import.meta.url);

let backend = null;
let apiBase = "";

before(async () => {
  process.env.NODE_ENV = "development";
  process.env.USE_PG_MEM = "1";
  process.env.JWT_SECRET = "test-jwt-secret-guards";
  process.env.ADMIN_API_KEY = "test-admin-key";
  process.env.APP_BASE_URL = "http://localhost:4173";
  process.env.FRONTEND_ORIGINS = "http://localhost:4173";
  process.env.SHOW_DEV_OTP = "1";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENAI_API_BASE = "http://127.0.0.1:9999/v1";
  process.env.OPENAI_MODEL = "mock-gpt";

  const serverPath = require.resolve("../server.js");
  delete require.cache[serverPath];
  backend = require(serverPath);
  const started = await backend.startServer({ port: 0, host: "127.0.0.1" });
  apiBase = "http://127.0.0.1:" + started.port;
});

after(async () => {
  if (backend && typeof backend.stopServer === "function") {
    await backend.stopServer();
  }
});

async function requestRaw(method, path, body, extraHeaders = {}) {
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    extraHeaders || {}
  );
  const options = {
    method,
    headers,
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(apiBase + path, options);
  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) : {};
  return {
    status: response.status,
    ok: response.ok,
    body: parsed,
  };
}

test("admin endpoints reject requests without admin auth", async () => {
  const response = await requestRaw("GET", "/api/admin/metrics?days=7");
  assert.equal(response.status, 403);
  assert.equal(response.ok, false);
  assert.equal(response.body.error, "Acceso admin requerido.");
});

test("events/track rejects oversized payload", async () => {
  const response = await requestRaw("POST", "/api/events/track", {
    eventName: "stress_payload",
    payload: { huge: "x".repeat(20_000) },
  });
  assert.equal(response.status, 413);
  assert.equal(response.ok, false);
  assert.equal(response.body.error, "payload demasiado grande para tracking.");
});

test("pay/consume validates unit bounds before business logic", async () => {
  const response = await requestRaw("POST", "/api/pay/consume", {
    customerId: "cust_bounds_test",
    units: 51,
  });
  assert.equal(response.status, 400);
  assert.equal(response.ok, false);
  assert.equal(response.body.error, "units debe ser un entero entre 1 y 50.");
});

test("webhook fails closed when stripe is not configured", async () => {
  const response = await requestRaw("POST", "/api/pay/webhook", {
    id: "evt_test_1",
    type: "checkout.session.completed",
  });
  assert.equal(response.status, 503);
  assert.equal(response.ok, false);
  assert.equal(response.body.error, "Stripe no configurado en servidor.");
});

test("health endpoint returns requestId on handled internal error", async () => {
  const originalQuery = backend.pool.query;
  backend.pool.query = async function mockedFailingQuery() {
    throw new Error("forced-db-error-for-test");
  };

  try {
    const response = await requestRaw("GET", "/api/health");
    assert.equal(response.status, 500);
    assert.equal(response.ok, false);
    assert.equal(response.body.error, "No se pudo completar healthcheck.");
    assert.ok(response.body.requestId);
    assert.equal("detail" in response.body, false);
  } finally {
    backend.pool.query = originalQuery;
  }
});
