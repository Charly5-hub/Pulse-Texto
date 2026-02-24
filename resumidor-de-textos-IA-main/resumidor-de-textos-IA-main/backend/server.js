require("dotenv").config();

const cors = require("cors");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const Stripe = require("stripe");

const app = express();

const PORT = Number(process.env.PORT || 8787);
const APP_BASE_URL = (process.env.APP_BASE_URL || "http://localhost:4173").trim();
const OPENAI_API_BASE = (process.env.OPENAI_API_BASE || "https://api.openai.com/v1").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
const PRICE_CURRENCY = (process.env.PRICE_CURRENCY || "eur").trim().toLowerCase();

const CREDIT_ONE = readNumber("CREDIT_ONE", 1);
const CREDIT_PACK = readNumber("CREDIT_PACK", 10);
const CREDIT_SUB_MONTH = readNumber("CREDIT_SUB_MONTH", 250);

const PRICE_ONE_CENTS = readNumber("PRICE_ONE_CENTS", 100);
const PRICE_PACK_CENTS = readNumber("PRICE_PACK_CENTS", 500);
const PRICE_SUB_CENTS = readNumber("PRICE_SUB_CENTS", 800);

const FRONTEND_ORIGINS = String(
  process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || "http://localhost:4173"
)
  .split(",")
  .map(function trim(item) { return item.trim(); })
  .filter(Boolean);

const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
const stripeWebhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

const PLAN_CONFIG = {
  one: {
    id: "one",
    label: "1 uso",
    mode: "payment",
    credits: CREDIT_ONE,
    unitAmountCents: PRICE_ONE_CENTS,
    stripePriceId: (process.env.STRIPE_PRICE_ONE || "").trim(),
  },
  pack: {
    id: "pack",
    label: "10 usos",
    mode: "payment",
    credits: CREDIT_PACK,
    unitAmountCents: PRICE_PACK_CENTS,
    stripePriceId: (process.env.STRIPE_PRICE_PACK || "").trim(),
  },
  sub: {
    id: "sub",
    label: "Suscripción mensual",
    mode: "subscription",
    credits: CREDIT_SUB_MONTH,
    unitAmountCents: PRICE_SUB_CENTS,
    stripePriceId: (process.env.STRIPE_PRICE_SUB || "").trim(),
  },
};

const DATA_DIR = path.join(__dirname, "data");
const LEDGER_FILE = path.join(DATA_DIR, "ledger.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.ndjson");

let storeCache = null;
let writeQueue = Promise.resolve();

const ALLOW_ANY_ORIGIN = FRONTEND_ORIGINS.includes("*");

app.use(cors({
  origin: function originValidator(origin, callback) {
    if (!origin || ALLOW_ANY_ORIGIN || FRONTEND_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origen no permitido por CORS: " + origin));
  },
  credentials: true,
}));

app.post("/api/pay/webhook", express.raw({ type: "application/json" }), async function webhookHandler(req, res) {
  if (!stripe) {
    res.status(503).json({ error: "Stripe no configurado en servidor." });
    return;
  }
  if (!stripeWebhookSecret) {
    res.status(500).json({ error: "Falta STRIPE_WEBHOOK_SECRET para validar webhook." });
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    res.status(400).json({ error: "Falta cabecera stripe-signature." });
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (error) {
    res.status(400).json({ error: "Webhook inválido.", detail: String(error && error.message || error) });
    return;
  }

  try {
    if (event.type === "checkout.session.completed") {
      await processCheckoutCompleted(event.data.object);
    } else if (event.type === "invoice.paid") {
      await processInvoicePaid(event.data.object);
    } else if (event.type === "customer.subscription.deleted") {
      await processSubscriptionDeleted(event.data.object);
    } else if (event.type === "customer.subscription.updated") {
      await processSubscriptionUpdated(event.data.object);
    }
    res.json({ received: true });
  } catch (error) {
    res.status(500).json({ error: "Error procesando webhook.", detail: String(error && error.message || error) });
  }
});

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async function healthHandler(_req, res) {
  await ensureDataFiles();
  res.json({
    ok: true,
    stripeConfigured: Boolean(stripe),
    webhookConfigured: Boolean(stripeWebhookSecret),
    aiConfigured: Boolean(OPENAI_API_KEY),
    plans: publicPlans(),
    now: new Date().toISOString(),
  });
});

app.get("/api/pay/plans", function plansHandler(_req, res) {
  res.json({
    stripeConfigured: Boolean(stripe),
    currency: PRICE_CURRENCY,
    plans: publicPlans(),
  });
});

app.post("/api/pay/checkout", async function checkoutHandler(req, res) {
  if (!stripe) {
    res.status(503).json({ error: "Stripe no está configurado todavía." });
    return;
  }

  const planId = String(req.body && req.body.plan || "").trim();
  const customerId = normalizeCustomerId(req.body && req.body.customerId);
  if (!customerId) {
    res.status(400).json({ error: "customerId es obligatorio." });
    return;
  }

  const plan = PLAN_CONFIG[planId];
  if (!plan) {
    res.status(400).json({ error: "Plan inválido. Usa one, pack o sub." });
    return;
  }

  const metadata = {
    customer_id: customerId,
    plan: plan.id,
    credits_granted: String(plan.credits),
  };

  const params = {
    mode: plan.mode,
    line_items: buildLineItems(plan),
    success_url: APP_BASE_URL + "/?checkout=success&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: APP_BASE_URL + "/?checkout=cancel",
    allow_promotion_codes: true,
    client_reference_id: customerId,
    metadata: metadata,
  };

  if (plan.mode === "payment") {
    params.customer_creation = "always";
  }
  if (plan.mode === "subscription") {
    params.subscription_data = { metadata: metadata };
  }

  try {
    const session = await stripe.checkout.sessions.create(params);
    await mutateStore(function storeCheckout(store) {
      const user = ensureUser(store, customerId);
      user.lastCheckoutAt = nowISO();
      store.payments[session.id] = {
        id: session.id,
        planId: plan.id,
        customerId: customerId,
        creditsGranted: plan.credits,
        status: "created",
        amountTotal: null,
        currency: PRICE_CURRENCY,
        granted: false,
        createdAt: nowISO(),
        updatedAt: nowISO(),
      };
      return null;
    });

    res.json({
      ok: true,
      sessionId: session.id,
      checkoutUrl: session.url,
      plan: plan.id,
    });
  } catch (error) {
    res.status(500).json({
      error: "No se pudo crear Checkout Session.",
      detail: String(error && error.message || error),
    });
  }
});

app.get("/api/pay/balance", async function balanceHandler(req, res) {
  const customerId = normalizeCustomerId(req.query.customerId);
  if (!customerId) {
    res.status(400).json({ error: "customerId es obligatorio." });
    return;
  }

  const snapshot = await mutateStore(function touchUser(store) {
    const user = ensureUser(store, customerId);
    return sanitizeUserSnapshot(user);
  });

  res.json({
    ok: true,
    customerId: customerId,
    balance: snapshot,
  });
});

app.post("/api/pay/consume", async function consumeHandler(req, res) {
  const customerId = normalizeCustomerId(req.body && req.body.customerId);
  const units = toPositiveInt(req.body && req.body.units, 1);

  if (!customerId) {
    res.status(400).json({ error: "customerId es obligatorio." });
    return;
  }

  if (!Number.isInteger(units) || units <= 0 || units > 50) {
    res.status(400).json({ error: "units debe ser un entero entre 1 y 50." });
    return;
  }

  try {
    const result = await mutateStore(function spendCredits(store) {
      const user = ensureUser(store, customerId);
      if (user.credits < units) {
        const spendError = new Error("Créditos insuficientes.");
        spendError.code = "INSUFFICIENT_CREDITS";
        throw spendError;
      }
      user.credits -= units;
      user.totalConsumedCredits += units;
      user.updatedAt = nowISO();
      return sanitizeUserSnapshot(user);
    });

    res.json({
      ok: true,
      customerId: customerId,
      consumed: units,
      balance: result,
    });
  } catch (error) {
    if (error && error.code === "INSUFFICIENT_CREDITS") {
      res.status(402).json({ error: "Créditos insuficientes." });
      return;
    }
    res.status(500).json({ error: "No se pudo consumir crédito.", detail: String(error && error.message || error) });
  }
});

app.post("/api/events/track", async function eventTrackHandler(req, res) {
  const eventName = String(req.body && req.body.eventName || "").trim();
  const customerId = normalizeCustomerId(req.body && req.body.customerId);
  const payload = req.body && typeof req.body.payload === "object" && req.body.payload ? req.body.payload : {};

  if (!eventName) {
    res.status(400).json({ error: "eventName es obligatorio." });
    return;
  }

  const eventRecord = {
    id: "evt_" + crypto.randomUUID().replace(/-/g, ""),
    at: nowISO(),
    eventName: eventName,
    customerId: customerId || null,
    payload: payload,
  };

  try {
    await fs.appendFile(EVENTS_FILE, JSON.stringify(eventRecord) + "\n", "utf8");
    await mutateStore(function countMetrics(store) {
      store.metrics[eventName] = (store.metrics[eventName] || 0) + 1;
      if (customerId) {
        ensureUser(store, customerId);
      }
      return null;
    });
  } catch (error) {
    res.status(500).json({ error: "No se pudo registrar evento.", detail: String(error && error.message || error) });
    return;
  }

  res.status(202).json({ ok: true });
});

app.post("/api/ai/generate", async function aiGenerateHandler(req, res) {
  if (!OPENAI_API_KEY) {
    res.status(503).json({ error: "OPENAI_API_KEY no configurada en servidor." });
    return;
  }

  const input = String(req.body && req.body.input || "").trim();
  const systemPrompt = String(req.body && req.body.systemPrompt || "Eres un editor experto en textos en español.").trim();
  const userPrompt = String(req.body && req.body.userPrompt || input).trim();
  const requestedModel = String(req.body && req.body.model || OPENAI_MODEL).trim() || OPENAI_MODEL;
  const temperature = Number.isFinite(Number(req.body && req.body.temperature))
    ? Number(req.body.temperature)
    : 0.2;

  if (!input) {
    res.status(400).json({ error: "input es obligatorio." });
    return;
  }

  try {
    const response = await fetch(trimTrailingSlash(OPENAI_API_BASE) + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: requestedModel,
        temperature: temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    const rawText = await response.text();
    let json = null;
    if (rawText) {
      try {
        json = JSON.parse(rawText);
      } catch (_error) {
        json = null;
      }
    }

    if (!response.ok) {
      const detail = extractOutput(json) || rawText || ("HTTP " + response.status);
      res.status(response.status).json({ error: "Fallo en proveedor IA.", detail: detail });
      return;
    }

    const output = extractOutput(json);
    if (!output) {
      res.status(502).json({ error: "Proveedor IA no devolvió contenido." });
      return;
    }

    res.json({
      output: output,
      model: (json && json.model) || requestedModel,
      provider: "openai_compat",
      usage: json && json.usage ? json.usage : null,
    });
  } catch (error) {
    res.status(500).json({
      error: "No se pudo completar la generación IA.",
      detail: String(error && error.message || error),
    });
  }
});

app.use(function errorHandler(err, _req, res, _next) {
  res.status(500).json({ error: "Error interno.", detail: String(err && err.message || err) });
});

ensureDataFiles()
  .then(function startServer() {
    app.listen(PORT, function onListen() {
      console.log("[simplify-backend] listening on port " + PORT);
    });
  })
  .catch(function startupFailure(error) {
    console.error("[simplify-backend] startup error", error);
    process.exit(1);
  });

function readNumber(name, fallback) {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nowISO() {
  return new Date().toISOString();
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function normalizeCustomerId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 96);
  return normalized;
}

function createDefaultStore() {
  return {
    version: 1,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    users: {},
    byStripeCustomer: {},
    payments: {},
    processedInvoices: {},
    metrics: {},
  };
}

function sanitizeStoreShape(store) {
  if (!store || typeof store !== "object") {
    return createDefaultStore();
  }

  if (!store.users || typeof store.users !== "object") {
    store.users = {};
  }
  if (!store.byStripeCustomer || typeof store.byStripeCustomer !== "object") {
    store.byStripeCustomer = {};
  }
  if (!store.payments || typeof store.payments !== "object") {
    store.payments = {};
  }
  if (!store.processedInvoices || typeof store.processedInvoices !== "object") {
    store.processedInvoices = {};
  }
  if (!store.metrics || typeof store.metrics !== "object") {
    store.metrics = {};
  }

  return store;
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await ensureFile(LEDGER_FILE, JSON.stringify(createDefaultStore(), null, 2) + "\n");
  await ensureFile(EVENTS_FILE, "");
}

async function ensureFile(filePath, initialContent) {
  try {
    await fs.access(filePath);
  } catch (_error) {
    await fs.writeFile(filePath, initialContent, "utf8");
  }
}

async function loadStore() {
  if (storeCache) {
    return storeCache;
  }
  await ensureDataFiles();

  try {
    const raw = await fs.readFile(LEDGER_FILE, "utf8");
    const parsed = raw ? JSON.parse(raw) : createDefaultStore();
    storeCache = sanitizeStoreShape(parsed);
  } catch (_error) {
    storeCache = createDefaultStore();
  }
  return storeCache;
}

async function mutateStore(mutator) {
  const store = await loadStore();
  const result = mutator(store);
  store.updatedAt = nowISO();

  writeQueue = writeQueue.then(function flushStore() {
    return fs.writeFile(LEDGER_FILE, JSON.stringify(store, null, 2) + "\n", "utf8");
  });
  await writeQueue;
  return result;
}

function ensureUser(store, customerId) {
  const id = normalizeCustomerId(customerId);
  if (!id) {
    throw new Error("customerId inválido.");
  }

  if (!store.users[id]) {
    store.users[id] = {
      customerId: id,
      credits: 0,
      totalPurchasedCredits: 0,
      totalConsumedCredits: 0,
      subscriptionActive: false,
      subscriptionCreditsPerCycle: CREDIT_SUB_MONTH,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
  }

  store.users[id].updatedAt = nowISO();
  return store.users[id];
}

function sanitizeUserSnapshot(user) {
  return {
    credits: Math.max(0, Number(user.credits || 0)),
    totalPurchasedCredits: Math.max(0, Number(user.totalPurchasedCredits || 0)),
    totalConsumedCredits: Math.max(0, Number(user.totalConsumedCredits || 0)),
    subscriptionActive: Boolean(user.subscriptionActive),
    stripeCustomerId: user.stripeCustomerId || null,
    stripeSubscriptionId: user.stripeSubscriptionId || null,
    updatedAt: user.updatedAt || nowISO(),
  };
}

function publicPlans() {
  return Object.keys(PLAN_CONFIG).reduce(function reducePlans(acc, key) {
    const plan = PLAN_CONFIG[key];
    acc[key] = {
      id: plan.id,
      label: plan.label,
      mode: plan.mode,
      credits: plan.credits,
      amountCents: plan.unitAmountCents,
      currency: PRICE_CURRENCY,
      stripePriceIdConfigured: Boolean(plan.stripePriceId),
    };
    return acc;
  }, {});
}

function buildLineItems(plan) {
  if (plan.stripePriceId) {
    return [{ price: plan.stripePriceId, quantity: 1 }];
  }

  if (plan.mode === "subscription") {
    return [{
      price_data: {
        currency: PRICE_CURRENCY,
        recurring: { interval: "month" },
        unit_amount: plan.unitAmountCents,
        product_data: { name: plan.label },
      },
      quantity: 1,
    }];
  }

  return [{
    price_data: {
      currency: PRICE_CURRENCY,
      unit_amount: plan.unitAmountCents,
      product_data: { name: plan.label },
    },
    quantity: 1,
  }];
}

function resolveCustomerByStripeCustomer(store, stripeCustomerId) {
  const key = String(stripeCustomerId || "").trim();
  if (!key) {
    return "";
  }
  if (store.byStripeCustomer[key]) {
    return store.byStripeCustomer[key];
  }

  const userEntries = Object.entries(store.users || {});
  for (let i = 0; i < userEntries.length; i += 1) {
    const entry = userEntries[i];
    const customerId = entry[0];
    const user = entry[1];
    if (user && user.stripeCustomerId === key) {
      store.byStripeCustomer[key] = customerId;
      return customerId;
    }
  }
  return "";
}

async function processCheckoutCompleted(session) {
  await mutateStore(function onCheckout(store) {
    const customerFromMeta = normalizeCustomerId(session && session.metadata && session.metadata.customer_id);
    const customerFromClientRef = normalizeCustomerId(session && session.client_reference_id);
    const customerFromStripe = resolveCustomerByStripeCustomer(store, session && session.customer);
    const customerId = customerFromMeta || customerFromClientRef || customerFromStripe;
    if (!customerId) {
      return null;
    }

    const planId = String(session && session.metadata && session.metadata.plan || "").trim();
    const plan = PLAN_CONFIG[planId] || null;
    const creditsFromMeta = Number(session && session.metadata && session.metadata.credits_granted);
    const creditsGranted = Number.isFinite(creditsFromMeta)
      ? Math.max(0, Math.floor(creditsFromMeta))
      : (plan ? plan.credits : 0);

    const user = ensureUser(store, customerId);
    if (session && session.customer) {
      user.stripeCustomerId = String(session.customer);
      store.byStripeCustomer[String(session.customer)] = customerId;
    }
    if (session && session.subscription) {
      user.stripeSubscriptionId = String(session.subscription);
      user.subscriptionActive = true;
      if (creditsGranted > 0) {
        user.subscriptionCreditsPerCycle = creditsGranted;
      }
    }

    const existing = store.payments[session.id] || {};
    const alreadyGranted = Boolean(existing.granted);

    store.payments[session.id] = {
      id: session.id,
      planId: planId || existing.planId || "",
      customerId: customerId,
      creditsGranted: creditsGranted,
      status: "completed",
      amountTotal: session.amount_total || existing.amountTotal || null,
      currency: session.currency || existing.currency || PRICE_CURRENCY,
      granted: alreadyGranted || creditsGranted <= 0,
      stripeCustomerId: session.customer || existing.stripeCustomerId || null,
      stripeSubscriptionId: session.subscription || existing.stripeSubscriptionId || null,
      createdAt: existing.createdAt || nowISO(),
      updatedAt: nowISO(),
    };

    if (!alreadyGranted && creditsGranted > 0) {
      user.credits += creditsGranted;
      user.totalPurchasedCredits += creditsGranted;
    }

    return null;
  });
}

async function processInvoicePaid(invoice) {
  const invoiceId = String(invoice && invoice.id || "").trim();
  const stripeCustomerId = String(invoice && invoice.customer || "").trim();
  const billingReason = String(invoice && invoice.billing_reason || "").trim();

  if (!invoiceId || !stripeCustomerId) {
    return;
  }

  await mutateStore(function onInvoice(store) {
    if (store.processedInvoices[invoiceId]) {
      return null;
    }

    const customerId = resolveCustomerByStripeCustomer(store, stripeCustomerId);
    if (!customerId) {
      store.processedInvoices[invoiceId] = true;
      return null;
    }

    const user = ensureUser(store, customerId);
    user.subscriptionActive = true;

    if (billingReason === "subscription_cycle") {
      const credits = Math.max(0, Number(user.subscriptionCreditsPerCycle || CREDIT_SUB_MONTH));
      if (credits > 0) {
        user.credits += credits;
        user.totalPurchasedCredits += credits;
      }
    }

    store.processedInvoices[invoiceId] = true;
    return null;
  });
}

async function processSubscriptionDeleted(subscription) {
  const subscriptionId = String(subscription && subscription.id || "").trim();
  if (!subscriptionId) {
    return;
  }

  await mutateStore(function onSubscriptionDeleted(store) {
    const users = Object.values(store.users || {});
    for (let i = 0; i < users.length; i += 1) {
      const user = users[i];
      if (user && user.stripeSubscriptionId === subscriptionId) {
        user.subscriptionActive = false;
      }
    }
    return null;
  });
}

async function processSubscriptionUpdated(subscription) {
  const subscriptionId = String(subscription && subscription.id || "").trim();
  if (!subscriptionId) {
    return;
  }

  const activeStatuses = {
    active: true,
    trialing: true,
    past_due: true,
    unpaid: false,
    canceled: false,
    incomplete: false,
    incomplete_expired: false,
  };

  await mutateStore(function onSubscriptionUpdated(store) {
    const status = String(subscription && subscription.status || "").trim();
    const users = Object.values(store.users || {});
    for (let i = 0; i < users.length; i += 1) {
      const user = users[i];
      if (user && user.stripeSubscriptionId === subscriptionId) {
        user.subscriptionActive = Boolean(activeStatuses[status]);
      }
    }
    return null;
  });
}

function extractOutput(payload) {
  if (!payload) {
    return "";
  }
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (typeof payload.output === "string") {
    return payload.output.trim();
  }
  if (typeof payload.text === "string") {
    return payload.text.trim();
  }
  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const choice = payload.choices[0];
    if (choice && choice.message && typeof choice.message.content === "string") {
      return choice.message.content.trim();
    }
    if (choice && Array.isArray(choice.message && choice.message.content)) {
      return choice.message.content.map(function mapPart(part) {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      }).join("\n").trim();
    }
    if (choice && typeof choice.text === "string") {
      return choice.text.trim();
    }
  }
  if (Array.isArray(payload.output) && payload.output.length > 0) {
    return payload.output.map(function mapOutput(part) {
      if (!part) {
        return "";
      }
      if (typeof part === "string") {
        return part;
      }
      if (part.content && Array.isArray(part.content)) {
        return part.content.map(function mapChunk(chunk) {
          return chunk && chunk.text ? chunk.text : "";
        }).join("\n");
      }
      return "";
    }).join("\n").trim();
  }
  return "";
}
