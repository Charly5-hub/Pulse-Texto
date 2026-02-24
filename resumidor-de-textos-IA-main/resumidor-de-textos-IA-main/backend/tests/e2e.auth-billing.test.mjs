import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import test, { after, before } from "node:test";

const require = createRequire(import.meta.url);

let backend = null;
let apiBase = "";
let authToken = "";
let customerId = "";
let userId = "";
let openaiMockServer = null;
let openaiPort = 0;
let lastOpenaiPayload = null;

before(async () => {
  openaiMockServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += String(chunk);
      });
      req.on("end", () => {
        try {
          lastOpenaiPayload = raw ? JSON.parse(raw) : null;
        } catch (_error) {
          lastOpenaiPayload = null;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          model: "mock-gpt",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Salida IA de prueba para el test E2E." },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 11, total_tokens: 23 },
        }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  openaiMockServer.listen(0, "127.0.0.1");
  await once(openaiMockServer, "listening");
  openaiPort = Number(openaiMockServer.address().port);

  process.env.USE_PG_MEM = "1";
  process.env.JWT_SECRET = "test-jwt-secret-super-safe";
  process.env.ADMIN_API_KEY = "test-admin-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENAI_API_BASE = "http://127.0.0.1:" + openaiPort + "/v1";
  process.env.OPENAI_MODEL = "mock-gpt";
  process.env.APP_BASE_URL = "http://localhost:4173";
  process.env.FRONTEND_ORIGINS = "http://localhost:4173";
  process.env.SHOW_DEV_OTP = "1";
  process.env.FREE_USES = "3";
  process.env.RECOVERY_SEQUENCE_HOURS = "1,24,72";
  process.env.RECOVERY_MAX_ATTEMPTS = "3";
  process.env.RECOVERY_AB_ENABLED = "1";

  backend = require("../server.js");
  const started = await backend.startServer({ port: 0, host: "127.0.0.1" });
  apiBase = "http://127.0.0.1:" + started.port;
});

after(async () => {
  if (backend && typeof backend.stopServer === "function") {
    await backend.stopServer();
  }
  if (openaiMockServer) {
    await new Promise((resolve, reject) => {
      openaiMockServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

async function requestJSON(method, path, body, extraHeaders = {}) {
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
  if (!response.ok) {
    throw new Error("HTTP " + response.status + " " + (parsed.error || parsed.detail || raw));
  }
  return parsed;
}

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

test("anonymous session and email OTP login", async () => {
  const anonymous = await requestJSON("POST", "/api/auth/session/anonymous", {
    customerId: "cust_testsuite_e2e",
  });

  assert.equal(anonymous.ok, true);
  assert.ok(anonymous.token);
  assert.ok(anonymous.user);
  assert.equal(anonymous.user.provider, "anonymous");

  customerId = anonymous.user.customerId;

  const otpRequest = await requestJSON("POST", "/api/auth/email/request-code", {
    email: "qa+simplify@example.com",
    customerId,
  });

  assert.equal(otpRequest.ok, true);
  assert.ok(otpRequest.devCode, "Expected devCode for test mode");

  const verified = await requestJSON("POST", "/api/auth/email/verify-code", {
    email: "qa+simplify@example.com",
    code: otpRequest.devCode,
    customerId,
  });

  assert.equal(verified.ok, true);
  assert.ok(verified.token);
  assert.equal(verified.user.email, "qa+simplify@example.com");
  assert.equal(verified.user.provider, "email");

  authToken = verified.token;
  userId = verified.user.id;
});

test("legal consent can be recorded and consulted", async () => {
  const before = await requestJSON(
    "GET",
    "/api/legal/consent-status?customerId=" + encodeURIComponent(customerId) + "&version=2026-02",
    undefined,
    { Authorization: "Bearer " + authToken }
  );
  assert.equal(before.ok, true);
  assert.equal(before.accepted, false);

  const consent = await requestJSON(
    "POST",
    "/api/legal/consent",
    {
      accepted: true,
      version: "2026-02",
      source: "e2e-test",
      customerId,
    },
    { Authorization: "Bearer " + authToken }
  );
  assert.equal(consent.ok, true);
  assert.equal(consent.version, "2026-02");

  const after = await requestJSON(
    "GET",
    "/api/legal/consent-status?customerId=" + encodeURIComponent(customerId) + "&version=2026-02",
    undefined,
    { Authorization: "Bearer " + authToken }
  );
  assert.equal(after.ok, true);
  assert.equal(after.accepted, true);
});

test("AI generation consumes free quota server-side", async () => {
  const balanceBefore = await requestJSON(
    "GET",
    "/api/pay/balance?customerId=" + encodeURIComponent(customerId),
    undefined,
    { Authorization: "Bearer " + authToken }
  );

  const beforeFreeUsed = Number(balanceBefore.balance.freeUsed || 0);

  const generated = await requestJSON(
    "POST",
    "/api/ai/generate",
    {
      input: "Este es un texto de prueba para validar el flujo de generación.",
      systemPrompt: "Eres un editor claro y conciso.",
      userPrompt: "Resume este texto de prueba.",
      style: "technical",
      metadata: { customerId },
    },
    { Authorization: "Bearer " + authToken }
  );

  assert.ok(generated.output.includes("Salida IA de prueba"));
  assert.equal(generated.billing.source, "free");
  assert.equal(generated.style, "technical");
  assert.ok(lastOpenaiPayload && Array.isArray(lastOpenaiPayload.messages));
  assert.ok(
    String(lastOpenaiPayload.messages[0].content || "").includes("Estilo narrativo objetivo: técnico"),
    "Expected style guidance in system prompt"
  );
  assert.equal(Number(lastOpenaiPayload.temperature), 0.15);

  const balanceAfter = await requestJSON(
    "GET",
    "/api/pay/balance?customerId=" + encodeURIComponent(customerId),
    undefined,
    { Authorization: "Bearer " + authToken }
  );

  assert.equal(Number(balanceAfter.balance.freeUsed), beforeFreeUsed + 1);
});

test("admin can grant credits and user can consume them", async () => {
  const granted = await requestJSON(
    "POST",
    "/api/admin/credits/grant",
    {
      customerId,
      credits: 5,
    },
    {
      "x-admin-key": "test-admin-key",
    }
  );

  assert.equal(granted.ok, true);
  assert.equal(granted.granted, 5);
  assert.equal(Number(granted.user.balance.credits), 5);

  const consumed = await requestJSON(
    "POST",
    "/api/pay/consume",
    {
      customerId,
      units: 2,
    },
    { Authorization: "Bearer " + authToken }
  );

  assert.equal(consumed.ok, true);
  assert.equal(consumed.consumed, 2);
  assert.equal(Number(consumed.balance.credits), 3);
});

test("plan limits are enforced and can be upgraded by admin", async () => {
  const longInput = "a".repeat(9000);

  const blocked = await requestRaw(
    "POST",
    "/api/ai/generate",
    {
      input: longInput,
      style: "neutral",
      metadata: { customerId },
    },
    { Authorization: "Bearer " + authToken }
  );
  assert.equal(blocked.status, 413);
  assert.ok(String(blocked.body.error || "").includes("límite de tu plan"));

  const assigned = await requestJSON(
    "POST",
    "/api/admin/plan/assign",
    {
      customerId,
      planTier: "pack",
    },
    { "x-admin-key": "test-admin-key" }
  );
  assert.equal(assigned.ok, true);
  assert.equal(assigned.planTier, "pack");

  const allowed = await requestJSON(
    "POST",
    "/api/ai/generate",
    {
      input: longInput,
      style: "technical",
      metadata: { customerId },
    },
    { Authorization: "Bearer " + authToken }
  );
  assert.ok(allowed.output.includes("Salida IA de prueba"));
  assert.equal(allowed.planTier, "pack");
});

test("checkout recovery sweep processes pending sessions", async () => {
  const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await backend.pool.query(
    "INSERT INTO payment_sessions (session_id, user_id, customer_id, plan_id, status, amount_total, currency, credits_granted, granted, acquisition_channel, recovery_attempts, created_at, updated_at) VALUES ($1,$2,$3,$4,'created',NULL,$5,$6,false,$7,0,$8,$9)",
    [
      "cs_recovery_test_001",
      userId,
      customerId,
      "pack",
      "eur",
      10,
      "ads",
      createdAt,
      new Date().toISOString(),
    ]
  );

  const run = await requestJSON(
    "POST",
    "/api/admin/recovery/checkout/run",
    {
      limit: 20,
    },
    { "x-admin-key": "test-admin-key" }
  );
  assert.equal(run.ok, true);
  assert.ok(run.candidates >= 1);
  assert.ok(run.emailed >= 1);
  assert.deepEqual(run.sequenceHours, [1, 24, 72]);

  const row = await backend.pool.query(
    "SELECT recovery_attempts, recovery_email_sent_at, recovery_last_variant, recovery_last_step, recovery_next_attempt_at FROM payment_sessions WHERE session_id = $1",
    ["cs_recovery_test_001"]
  );
  assert.equal(row.rowCount, 1);
  assert.equal(Number(row.rows[0].recovery_attempts || 0), 1);
  assert.equal(Number(row.rows[0].recovery_last_step || 0), 1);
  assert.ok(["A", "B"].includes(String(row.rows[0].recovery_last_variant || "")));
  assert.ok(row.rows[0].recovery_next_attempt_at);

  const eventRows = await backend.pool.query(
    "SELECT payload FROM app_events WHERE event_name = 'checkout_recovery_email_sent' AND payload->>'sessionId' = $1 ORDER BY id ASC",
    ["cs_recovery_test_001"]
  );
  assert.ok(eventRows.rowCount >= 1);
  const firstPayload = eventRows.rows[0].payload;
  assert.equal(String(firstPayload.stepNumber), "1");
  assert.equal(String(firstPayload.segmentPlan), "pack");
  assert.equal(String(firstPayload.segmentChannel), "paid");
  assert.ok(["A", "B"].includes(String(firstPayload.variant || "")));

  await backend.pool.query(
    "UPDATE payment_sessions SET recovery_next_attempt_at = NOW() WHERE session_id = $1",
    ["cs_recovery_test_001"]
  );
  const runBlockedBySequence = await requestJSON(
    "POST",
    "/api/admin/recovery/checkout/run",
    {
      limit: 20,
    },
    { "x-admin-key": "test-admin-key" }
  );
  assert.equal(runBlockedBySequence.ok, true);
  assert.equal(Number(runBlockedBySequence.emailed || 0), 0);
  assert.ok(Number(runBlockedBySequence.notReady || 0) >= 1);

  const runForced = await requestJSON(
    "POST",
    "/api/admin/recovery/checkout/run",
    {
      limit: 20,
      force: true,
    },
    { "x-admin-key": "test-admin-key" }
  );
  assert.equal(runForced.ok, true);
  assert.ok(Number(runForced.emailed || 0) >= 1);

  const rowAfterForce = await backend.pool.query(
    "SELECT recovery_attempts, recovery_last_step FROM payment_sessions WHERE session_id = $1",
    ["cs_recovery_test_001"]
  );
  assert.equal(rowAfterForce.rowCount, 1);
  assert.equal(Number(rowAfterForce.rows[0].recovery_attempts || 0), 2);
  assert.equal(Number(rowAfterForce.rows[0].recovery_last_step || 0), 2);
});

test("admin metrics endpoint returns kpis and funnel", async () => {
  const metrics = await requestJSON(
    "GET",
    "/api/admin/metrics?days=30",
    undefined,
    { "x-admin-key": "test-admin-key" }
  );

  assert.equal(metrics.ok, true);
  assert.ok(metrics.kpis.totalUsers >= 1);
  assert.ok(typeof metrics.funnel.generationCompleted === "number");
  assert.ok(typeof metrics.unitEconomics.ltvCacRatio === "number");
  assert.ok(typeof metrics.checkoutRecovery.conversionRatePct === "number");
  assert.ok(Array.isArray(metrics.checkoutRecovery.byVariant));
  assert.ok(Array.isArray(metrics.checkoutRecovery.bySegment));
  assert.ok(Array.isArray(metrics.events));
  assert.ok(Array.isArray(metrics.dailyEvents));
});
