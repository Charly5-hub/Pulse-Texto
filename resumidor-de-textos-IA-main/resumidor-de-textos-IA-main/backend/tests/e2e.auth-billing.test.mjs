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
  assert.ok(Array.isArray(metrics.events));
  assert.ok(Array.isArray(metrics.dailyEvents));
});
