require("dotenv").config();

const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const Stripe = require("stripe");

const app = express();

const CONFIG = {
  port: Number(process.env.PORT || 8787),
  appBaseURL: String(process.env.APP_BASE_URL || "http://localhost:4173").trim(),
  frontendOrigins: String(process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || "http://localhost:4173")
    .split(",")
    .map(function mapOrigin(item) { return item.trim(); })
    .filter(Boolean),
  databaseURL: String(process.env.DATABASE_URL || "").trim(),
  usePgMem: String(process.env.USE_PG_MEM || "").trim() === "1",
  postgresSSL: String(process.env.POSTGRES_SSL || "false").trim() === "true",
  openaiBase: String(process.env.OPENAI_API_BASE || "https://api.openai.com/v1").trim(),
  openaiKey: String(process.env.OPENAI_API_KEY || "").trim(),
  openaiModel: String(process.env.OPENAI_MODEL || "gpt-4.1-mini").trim(),
  stripeKey: String(process.env.STRIPE_SECRET_KEY || "").trim(),
  stripeWebhookSecret: String(process.env.STRIPE_WEBHOOK_SECRET || "").trim(),
  priceCurrency: String(process.env.PRICE_CURRENCY || "eur").trim().toLowerCase(),
  freeUses: readNumber("FREE_USES", 3),
  creditOne: readNumber("CREDIT_ONE", 1),
  creditPack: readNumber("CREDIT_PACK", 10),
  creditSubMonth: readNumber("CREDIT_SUB_MONTH", 250),
  priceOneCents: readNumber("PRICE_ONE_CENTS", 100),
  pricePackCents: readNumber("PRICE_PACK_CENTS", 500),
  priceSubCents: readNumber("PRICE_SUB_CENTS", 800),
  jwtSecret: String(process.env.JWT_SECRET || "dev-jwt-secret-change-me").trim(),
  jwtExpiresIn: String(process.env.JWT_EXPIRES_IN || "30d").trim(),
  adminAPIKey: String(process.env.ADMIN_API_KEY || "").trim(),
  otpPepper: String(process.env.OTP_PEPPER || "dev-otp-pepper-change-me").trim(),
  otpTTLMinutes: readNumber("OTP_TTL_MINUTES", 10),
  otpMaxAttempts: readNumber("OTP_MAX_ATTEMPTS", 5),
  showDevOTP: String(process.env.SHOW_DEV_OTP || "").trim() === "1" || process.env.NODE_ENV !== "production",
  googleClientId: String(process.env.GOOGLE_CLIENT_ID || "").trim(),
  smtpHost: String(process.env.SMTP_HOST || "").trim(),
  smtpPort: readNumber("SMTP_PORT", 587),
  smtpSecure: String(process.env.SMTP_SECURE || "false").trim() === "true",
  smtpUser: String(process.env.SMTP_USER || "").trim(),
  smtpPass: String(process.env.SMTP_PASS || "").trim(),
  smtpFrom: String(process.env.SMTP_FROM || "noreply@simplify.local").trim(),
  legalVersion: String(process.env.LEGAL_VERSION || "2026-02").trim(),
  legalRequireCheckoutConsent: String(process.env.LEGAL_REQUIRE_CHECKOUT_CONSENT || "1").trim() !== "0",
};

const dbRuntime = createDatabaseRuntime();
const pool = dbRuntime.pool;
const DB_PROVIDER = dbRuntime.provider;

const stripe = CONFIG.stripeKey ? new Stripe(CONFIG.stripeKey) : null;

const mailer = createMailer();

const PLAN_CONFIG = {
  one: {
    id: "one",
    label: "1 uso",
    mode: "payment",
    credits: CONFIG.creditOne,
    unitAmountCents: CONFIG.priceOneCents,
    stripePriceId: String(process.env.STRIPE_PRICE_ONE || "").trim(),
  },
  pack: {
    id: "pack",
    label: "10 usos",
    mode: "payment",
    credits: CONFIG.creditPack,
    unitAmountCents: CONFIG.pricePackCents,
    stripePriceId: String(process.env.STRIPE_PRICE_PACK || "").trim(),
  },
  sub: {
    id: "sub",
    label: "Suscripción mensual",
    mode: "subscription",
    credits: CONFIG.creditSubMonth,
    unitAmountCents: CONFIG.priceSubCents,
    stripePriceId: String(process.env.STRIPE_PRICE_SUB || "").trim(),
  },
};

const ALLOW_ANY_ORIGIN = CONFIG.frontendOrigins.includes("*");
const RATE_LIMITERS = {
  globalApi: createRateLimiter({
    name: "global-api",
    windowMs: 5 * 60 * 1000,
    max: 400,
    keyFn: function key(req) {
      return getClientKey(req);
    },
  }),
  authAnonymous: createRateLimiter({
    name: "auth-anonymous",
    windowMs: 10 * 60 * 1000,
    max: 40,
    keyFn: function key(req) {
      return getClientKey(req);
    },
  }),
  authRequestCode: createRateLimiter({
    name: "auth-request-code",
    windowMs: 15 * 60 * 1000,
    max: 8,
    keyFn: function key(req) {
      return getClientKey(req) + ":" + normalizeEmail(req.body && req.body.email);
    },
  }),
  authVerifyCode: createRateLimiter({
    name: "auth-verify-code",
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyFn: function key(req) {
      return getClientKey(req) + ":" + normalizeEmail(req.body && req.body.email);
    },
  }),
  authGoogle: createRateLimiter({
    name: "auth-google",
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyFn: function key(req) {
      return getClientKey(req);
    },
  }),
  checkout: createRateLimiter({
    name: "checkout",
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyFn: function key(req) {
      return getClientKey(req) + ":" + normalizeCustomerId(req.body && req.body.customerId);
    },
  }),
  payConsume: createRateLimiter({
    name: "pay-consume",
    windowMs: 2 * 60 * 1000,
    max: 60,
    keyFn: function key(req) {
      return getClientKey(req) + ":" + normalizeCustomerId(req.body && req.body.customerId);
    },
  }),
  checkoutStatus: createRateLimiter({
    name: "checkout-status",
    windowMs: 60 * 1000,
    max: 90,
    keyFn: function key(req) {
      return getClientKey(req) + ":" + normalizeCustomerId(req.query && req.query.customerId);
    },
  }),
  eventsTrack: createRateLimiter({
    name: "events-track",
    windowMs: 60 * 1000,
    max: 180,
    keyFn: function key(req) {
      return getClientKey(req);
    },
  }),
  aiGenerate: createRateLimiter({
    name: "ai-generate",
    windowMs: 60 * 1000,
    max: 80,
    keyFn: function key(req) {
      var customerFromBody = normalizeCustomerId(req.body && req.body.customerId);
      var customerFromMeta = normalizeCustomerId(req.body && req.body.metadata && req.body.metadata.customerId);
      var stable = customerFromMeta || customerFromBody;
      return getClientKey(req) + ":" + stable;
    },
  }),
  adminRead: createRateLimiter({
    name: "admin-read",
    windowMs: 60 * 1000,
    max: 60,
    keyFn: function key(req) {
      return getClientKey(req);
    },
  }),
  adminWrite: createRateLimiter({
    name: "admin-write",
    windowMs: 60 * 1000,
    max: 30,
    keyFn: function key(req) {
      return getClientKey(req);
    },
  }),
  legalRead: createRateLimiter({
    name: "legal-read",
    windowMs: 60 * 1000,
    max: 120,
    keyFn: function key(req) {
      return getClientKey(req);
    },
  }),
  legalWrite: createRateLimiter({
    name: "legal-write",
    windowMs: 60 * 1000,
    max: 40,
    keyFn: function key(req) {
      return getClientKey(req) + ":" + normalizeCustomerId(req.body && req.body.customerId);
    },
  }),
};

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(requestContextMiddleware);
app.use(securityHeadersMiddleware);

app.use(cors({
  origin: function originValidator(origin, callback) {
    if (!origin || ALLOW_ANY_ORIGIN || CONFIG.frontendOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origen no permitido por CORS: " + origin));
  },
  credentials: true,
}));

app.post("/api/pay/webhook", express.raw({ type: "application/json" }), async function handleWebhook(req, res) {
  if (!stripe) {
    res.status(503).json({ error: "Stripe no configurado en servidor." });
    return;
  }
  if (!CONFIG.stripeWebhookSecret) {
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
    event = stripe.webhooks.constructEvent(req.body, signature, CONFIG.stripeWebhookSecret);
  } catch (error) {
    res.status(400).json({ error: "Webhook inválido.", detail: String(error && error.message || error) });
    return;
  }

  try {
    const processed = await withTransaction(async function processWebhook(client) {
      const dedupe = await client.query(
        "INSERT INTO webhook_events (event_id, event_type, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
        [event.id, event.type, JSON.stringify(event)]
      );
      if (dedupe.rowCount === 0) {
        return { deduped: true };
      }

      if (event.type === "checkout.session.completed") {
        await processCheckoutCompleted(client, event.data.object);
      } else if (event.type === "invoice.paid") {
        await processInvoicePaid(client, event.data.object);
      } else if (event.type === "customer.subscription.updated") {
        await processSubscriptionUpdated(client, event.data.object);
      } else if (event.type === "customer.subscription.deleted") {
        await processSubscriptionDeleted(client, event.data.object);
      }
      return { deduped: false };
    });

    res.json({ received: true, deduped: Boolean(processed && processed.deduped) });
  } catch (error) {
    res.status(500).json({ error: "Error procesando webhook.", detail: String(error && error.message || error) });
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(authOptional);
app.use(RATE_LIMITERS.globalApi);

app.get("/api/health", async function healthHandler(_req, res) {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      db: DB_PROVIDER,
      stripeConfigured: Boolean(stripe),
      webhookConfigured: Boolean(CONFIG.stripeWebhookSecret),
      aiConfigured: Boolean(CONFIG.openaiKey),
      auth: {
        googleConfigured: Boolean(CONFIG.googleClientId),
        emailConfigured: Boolean(mailer),
      },
      legal: {
        version: CONFIG.legalVersion,
        checkoutConsentRequired: CONFIG.legalRequireCheckoutConsent,
      },
      plans: publicPlans(),
      now: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error && error.message || error) });
  }
});

app.post("/api/auth/session/anonymous", RATE_LIMITERS.authAnonymous, async function createAnonymousSession(req, res) {
  const incomingCustomerId = normalizeCustomerId(req.body && req.body.customerId);
  const customerId = incomingCustomerId || generateCustomerId();

  try {
    const user = await withTransaction(async function tx(client) {
      return ensureUserByCustomerId(client, customerId);
    });

    res.json(buildSessionResponse(user));
  } catch (error) {
    res.status(500).json({ error: "No se pudo crear sesión anónima.", detail: String(error && error.message || error) });
  }
});

app.get("/api/auth/me", requireAuth, function authMe(req, res) {
  res.json({
    ok: true,
    user: publicUser(req.authUser),
  });
});

app.post("/api/auth/email/request-code", RATE_LIMITERS.authRequestCode, async function requestEmailCode(req, res) {
  const email = normalizeEmail(req.body && req.body.email);
  const incomingCustomerId = normalizeCustomerId(req.body && req.body.customerId);
  const customerId = incomingCustomerId || generateCustomerId();

  if (!isValidEmail(email)) {
    res.status(400).json({ error: "Email inválido." });
    return;
  }

  const code = generateOTPCode();
  const codeHash = hashOTPCode(email, code);
  const expiresAt = new Date(Date.now() + CONFIG.otpTTLMinutes * 60 * 1000);

  try {
    const user = await withTransaction(async function tx(client) {
      const currentUser = await ensureUserByCustomerId(client, customerId);
      await client.query(
        "INSERT INTO email_login_codes (email, code_hash, attempts, expires_at, created_at) VALUES ($1, $2, 0, $3, NOW()) ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = NOW()",
        [email, codeHash, expiresAt.toISOString()]
      );
      await recordEvent(client, "auth_email_code_requested", currentUser.id, currentUser.customer_id, { emailDomain: email.split("@")[1] || "" });
      return currentUser;
    });

    const delivery = await deliverOTPEmail(email, code, expiresAt);
    const payload = {
      ok: true,
      delivery: delivery,
      customerId: user.customer_id,
      expiresInMinutes: CONFIG.otpTTLMinutes,
    };

    if (delivery === "dev-log" && CONFIG.showDevOTP) {
      payload.devCode = code;
    }

    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: "No se pudo generar código de verificación.", detail: String(error && error.message || error) });
  }
});

app.post("/api/auth/email/verify-code", RATE_LIMITERS.authVerifyCode, async function verifyEmailCode(req, res) {
  const email = normalizeEmail(req.body && req.body.email);
  const code = String(req.body && req.body.code || "").trim();
  const incomingCustomerId = normalizeCustomerId(req.body && req.body.customerId);
  const customerId = incomingCustomerId || generateCustomerId();
  const name = normalizeDisplayName(req.body && req.body.name);

  if (!isValidEmail(email)) {
    res.status(400).json({ error: "Email inválido." });
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "Código inválido." });
    return;
  }

  try {
    const verifiedUser = await withTransaction(async function tx(client) {
      const codeRow = await client.query("SELECT email, code_hash, attempts, expires_at FROM email_login_codes WHERE email = $1", [email]);
      if (codeRow.rowCount === 0) {
        throw createError("Código no encontrado para este email.", 400);
      }

      const row = codeRow.rows[0];
      const expiresAt = new Date(row.expires_at);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
        await client.query("DELETE FROM email_login_codes WHERE email = $1", [email]);
        throw createError("Código expirado. Solicita uno nuevo.", 400);
      }

      if (Number(row.attempts) >= CONFIG.otpMaxAttempts) {
        throw createError("Límite de intentos alcanzado. Solicita un nuevo código.", 429);
      }

      const expectedHash = hashOTPCode(email, code);
      if (expectedHash !== row.code_hash) {
        await client.query("UPDATE email_login_codes SET attempts = attempts + 1 WHERE email = $1", [email]);
        throw createError("Código incorrecto.", 400);
      }

      let currentUser = await ensureUserByCustomerId(client, customerId);
      const existingByEmail = await getUserByEmail(client, email);
      if (existingByEmail && existingByEmail.id !== currentUser.id) {
        await mergeUsers(client, existingByEmail.id, currentUser.id);
      }

      await client.query(
        "UPDATE app_users SET email = $2, name = COALESCE($3, name), provider = 'email', updated_at = NOW() WHERE id = $1",
        [currentUser.id, email, name || null]
      );

      await client.query("DELETE FROM email_login_codes WHERE email = $1", [email]);

      currentUser = await getUserById(client, currentUser.id);
      await recordEvent(client, "auth_email_verified", currentUser.id, currentUser.customer_id, { provider: "email" });
      return currentUser;
    });

    res.json(buildSessionResponse(verifiedUser));
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: String(error && error.message || "No se pudo verificar código.") });
  }
});

app.post("/api/auth/google", RATE_LIMITERS.authGoogle, async function googleAuth(req, res) {
  if (!CONFIG.googleClientId) {
    res.status(503).json({ error: "Google Auth no configurado. Falta GOOGLE_CLIENT_ID." });
    return;
  }

  const idToken = String(req.body && req.body.idToken || "").trim();
  const incomingCustomerId = normalizeCustomerId(req.body && req.body.customerId);
  const customerId = incomingCustomerId || generateCustomerId();

  if (!idToken) {
    res.status(400).json({ error: "idToken es obligatorio." });
    return;
  }

  try {
    const payload = await verifyGoogleIdToken(idToken, CONFIG.googleClientId);
    if (!payload || !payload.sub) {
      throw createError("Token Google inválido.", 401);
    }

    const email = normalizeEmail(payload.email);
    const emailVerified = Boolean(payload.email_verified);
    const googleSub = String(payload.sub || "").trim();
    const name = normalizeDisplayName(payload.name);

    if (!googleSub) {
      throw createError("No se pudo obtener identity Google.", 401);
    }
    if (!email || !emailVerified) {
      throw createError("Cuenta Google sin email verificado.", 401);
    }

    const user = await withTransaction(async function tx(client) {
      let currentUser = await ensureUserByCustomerId(client, customerId);
      const byGoogle = await getUserByGoogleSub(client, googleSub);
      if (byGoogle && byGoogle.id !== currentUser.id) {
        await mergeUsers(client, byGoogle.id, currentUser.id);
      }

      const byEmail = await getUserByEmail(client, email);
      if (byEmail && byEmail.id !== currentUser.id) {
        await mergeUsers(client, byEmail.id, currentUser.id);
      }

      await client.query(
        "UPDATE app_users SET email = $2, name = COALESCE($3, name), provider = 'google', google_sub = $4, updated_at = NOW() WHERE id = $1",
        [currentUser.id, email, name || null, googleSub]
      );

      currentUser = await getUserById(client, currentUser.id);
      await recordEvent(client, "auth_google_verified", currentUser.id, currentUser.customer_id, { provider: "google" });
      return currentUser;
    });

    res.json(buildSessionResponse(user));
  } catch (error) {
    const status = Number(error && error.statusCode) || 401;
    res.status(status).json({
      error: "No se pudo validar Google login.",
      detail: String(error && error.message || error),
    });
  }
});

app.post("/api/auth/logout", function logout(_req, res) {
  res.json({ ok: true });
});

app.post("/api/legal/consent", RATE_LIMITERS.legalWrite, async function recordLegalConsentHandler(req, res) {
  const accepted = Boolean(req.body && req.body.accepted);
  const requestedVersion = normalizeLegalVersion(req.body && req.body.version) || CONFIG.legalVersion;
  const source = normalizeLegalSource(req.body && req.body.source) || "web";
  if (!accepted) {
    res.status(400).json({ error: "accepted=true es obligatorio para registrar consentimiento." });
    return;
  }
  if (!requestedVersion) {
    res.status(400).json({ error: "version legal inválida." });
    return;
  }

  try {
    const actor = await withTransaction(async function tx(client) {
      const user = await resolveUserFromRequest(client, req, req.body && req.body.customerId, {
        createIfMissing: true,
        allowGeneratedCustomer: false,
      });
      if (!user) {
        throw createError("customerId o sesión autenticada requerida.", 400);
      }
      await upsertLegalConsent(client, user, requestedVersion, source, req);
      await recordEvent(client, "legal_consent_recorded", user.id, user.customer_id, {
        version: requestedVersion,
        source: source,
      });
      return user;
    });

    res.json({
      ok: true,
      customerId: actor.customer_id,
      version: requestedVersion,
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: String(error && error.message || "No se pudo registrar consentimiento legal.") });
  }
});

app.get("/api/legal/consent-status", RATE_LIMITERS.legalRead, async function legalConsentStatusHandler(req, res) {
  const requestedVersion = normalizeLegalVersion(req.query && req.query.version) || CONFIG.legalVersion;
  if (!requestedVersion) {
    res.status(400).json({ error: "version legal inválida." });
    return;
  }

  try {
    const result = await withTransaction(async function tx(client) {
      const user = await resolveUserFromRequest(client, req, req.query && req.query.customerId, {
        createIfMissing: false,
        allowGeneratedCustomer: false,
      });
      if (!user) {
        throw createError("customerId o sesión autenticada requerida.", 400);
      }
      const accepted = await hasLegalConsent(client, user.id, requestedVersion);
      return {
        user: user,
        accepted: accepted,
      };
    });
    res.json({
      ok: true,
      customerId: result.user.customer_id,
      version: requestedVersion,
      accepted: result.accepted,
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: String(error && error.message || "No se pudo consultar consentimiento legal.") });
  }
});

app.get("/api/pay/plans", function getPlans(_req, res) {
  res.json({
    stripeConfigured: Boolean(stripe),
    currency: CONFIG.priceCurrency,
    legal: {
      version: CONFIG.legalVersion,
      checkoutConsentRequired: CONFIG.legalRequireCheckoutConsent,
    },
    plans: publicPlans(),
  });
});

app.post("/api/pay/checkout", RATE_LIMITERS.checkout, async function createCheckout(req, res) {
  if (!stripe) {
    res.status(503).json({ error: "Stripe no está configurado todavía." });
    return;
  }

  const planId = String(req.body && req.body.plan || "").trim();
  const plan = PLAN_CONFIG[planId];
  if (!plan) {
    res.status(400).json({ error: "Plan inválido. Usa one, pack o sub." });
    return;
  }

  try {
    const checkoutContext = await withTransaction(async function tx(client) {
      var resolved = await resolveUserFromRequest(client, req, req.body && req.body.customerId, {
        createIfMissing: true,
        allowGeneratedCustomer: false,
      });
      if (!resolved) {
        throw createError("customerId es obligatorio para iniciar checkout.", 400);
      }
      var legalVersion = normalizeLegalVersion(req.body && req.body.legalVersion) || CONFIG.legalVersion;
      if (CONFIG.legalRequireCheckoutConsent) {
        if (Boolean(req.body && req.body.acceptLegal)) {
          await upsertLegalConsent(client, resolved, legalVersion, "checkout-inline", req);
        }
        var consented = await hasLegalConsent(client, resolved.id, legalVersion);
        if (!consented) {
          throw createError("Debes aceptar Términos y Privacidad para completar el pago.", 400);
        }
      }
      return {
        actor: resolved,
        legalVersion: legalVersion,
      };
    });
    const actor = checkoutContext.actor;
    const legalVersion = checkoutContext.legalVersion;

    const metadata = {
      user_id: actor.id,
      customer_id: actor.customer_id,
      plan: plan.id,
      credits_granted: String(plan.credits),
      legal_version: legalVersion,
    };

    const params = {
      mode: plan.mode,
      line_items: buildLineItems(plan),
      success_url: CONFIG.appBaseURL + "/?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: CONFIG.appBaseURL + "/?checkout=cancel",
      allow_promotion_codes: true,
      client_reference_id: actor.customer_id,
      metadata: metadata,
    };
    if (plan.mode === "payment") {
      params.customer_creation = "always";
    } else {
      params.subscription_data = { metadata: metadata };
    }

    const session = await stripe.checkout.sessions.create(params);

    await withTransaction(async function tx(client) {
      await client.query(
        "INSERT INTO payment_sessions (session_id, user_id, customer_id, plan_id, status, amount_total, currency, credits_granted, granted, stripe_customer_id, stripe_subscription_id, created_at, updated_at) VALUES ($1,$2,$3,$4,'created',NULL,$5,$6,false,NULL,NULL,NOW(),NOW()) ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id, customer_id = EXCLUDED.customer_id, plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, currency = EXCLUDED.currency, credits_granted = EXCLUDED.credits_granted, updated_at = NOW()",
        [session.id, actor.id, actor.customer_id, plan.id, CONFIG.priceCurrency, plan.credits]
      );
      await recordEvent(client, "checkout_started", actor.id, actor.customer_id, {
        plan: plan.id,
        sessionId: session.id,
        legalVersion: legalVersion,
      });
    });

    res.json({
      ok: true,
      sessionId: session.id,
      checkoutUrl: session.url,
      plan: plan.id,
      customerId: actor.customer_id,
      legalVersion: legalVersion,
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: "No se pudo crear Checkout Session.", detail: String(error && error.message || error) });
  }
});

app.get("/api/pay/checkout-status", RATE_LIMITERS.checkoutStatus, async function checkoutStatusHandler(req, res) {
  const requestedSessionId = String(req.query && req.query.sessionId || "").trim();
  if (!requestedSessionId) {
    res.status(400).json({ error: "sessionId es obligatorio." });
    return;
  }

  try {
    const initial = await withTransaction(async function tx(client) {
      const actor = await resolveUserFromRequest(client, req, req.query && req.query.customerId, {
        createIfMissing: false,
        allowGeneratedCustomer: false,
      });
      if (!actor) {
        throw createError("customerId o sesión autenticada requerida.", 400);
      }
      const statusResult = await client.query(
        "SELECT session_id, customer_id, plan_id, status, amount_total, currency, credits_granted, granted, updated_at FROM payment_sessions WHERE session_id = $1 LIMIT 1",
        [requestedSessionId]
      );
      if (statusResult.rowCount === 0) {
        throw createError("No existe la sesión de checkout indicada.", 404);
      }
      const row = statusResult.rows[0];
      const isAdmin = Boolean(req.authUser && req.authUser.role === "admin");
      if (!isAdmin && row.customer_id !== actor.customer_id) {
        throw createError("No autorizado para consultar esta sesión.", 403);
      }
      return {
        actor: actor,
        statusRow: row,
      };
    });

    var reconciled = false;
    if (stripe && initial.statusRow.status !== "completed") {
      try {
        const session = await stripe.checkout.sessions.retrieve(requestedSessionId);
        if (session && (session.payment_status === "paid" || session.status === "complete")) {
          await withTransaction(async function tx(client) {
            await processCheckoutCompleted(client, session);
          });
          reconciled = true;
        }
      } catch (error) {
        logError("checkout.status.reconcile.error", {
          requestId: req && req.requestId ? req.requestId : null,
          sessionId: requestedSessionId,
          message: String(error && error.message || error),
        });
      }
    }

    const finalResult = await withTransaction(async function tx(client) {
      const statusResult = await client.query(
        "SELECT session_id, customer_id, plan_id, status, amount_total, currency, credits_granted, granted, updated_at FROM payment_sessions WHERE session_id = $1 LIMIT 1",
        [requestedSessionId]
      );
      if (statusResult.rowCount === 0) {
        throw createError("No existe la sesión de checkout indicada.", 404);
      }
      const row = statusResult.rows[0];
      const user = await getUserByCustomerId(client, row.customer_id);
      return {
        statusRow: row,
        user: user,
      };
    });

    res.json({
      ok: true,
      sessionId: finalResult.statusRow.session_id,
      customerId: finalResult.statusRow.customer_id,
      planId: finalResult.statusRow.plan_id,
      status: finalResult.statusRow.status,
      granted: Boolean(finalResult.statusRow.granted),
      creditsGranted: Number(finalResult.statusRow.credits_granted || 0),
      amountTotal: finalResult.statusRow.amount_total || null,
      currency: finalResult.statusRow.currency || CONFIG.priceCurrency,
      reconciled: reconciled,
      updatedAt: finalResult.statusRow.updated_at || new Date().toISOString(),
      balance: finalResult.user ? buildBalancePayload(finalResult.user) : null,
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: String(error && error.message || "No se pudo consultar checkout status.") });
  }
});

app.get("/api/pay/balance", async function getBalance(req, res) {
  try {
    const user = await withTransaction(async function tx(client) {
      var resolved = await resolveUserFromRequest(client, req, req.query && req.query.customerId, {
        createIfMissing: true,
        allowGeneratedCustomer: false,
      });
      if (!resolved) {
        throw createError("customerId o sesión autenticada requerida.", 400);
      }
      return resolved;
    });
    res.json({
      ok: true,
      customerId: user.customer_id,
      balance: buildBalancePayload(user),
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: String(error && error.message || "No se pudo obtener balance.") });
  }
});

app.post("/api/pay/consume", RATE_LIMITERS.payConsume, async function consumeCredits(req, res) {
  const units = toPositiveInt(req.body && req.body.units, 1);
  if (units < 1 || units > 50) {
    res.status(400).json({ error: "units debe ser un entero entre 1 y 50." });
    return;
  }

  try {
    const result = await withTransaction(async function tx(client) {
      const user = await resolveUserFromRequest(client, req, req.body && req.body.customerId, {
        createIfMissing: true,
        allowGeneratedCustomer: false,
      });
      if (!user) {
        throw createError("customerId o sesión autenticada requerida.", 400);
      }
      const remaining = Number(user.credits || 0);
      if (remaining < units) {
        throw createError("Créditos insuficientes.", 402);
      }

      await client.query(
        "UPDATE user_credits SET credits = GREATEST(0, credits - $2::int), total_consumed = total_consumed + $2::int, updated_at = NOW() WHERE user_id = $1",
        [user.id, units]
      );

      const updated = await getUserById(client, user.id);
      await recordEvent(client, "credits_consumed", user.id, user.customer_id, { units: units });
      return updated;
    });

    res.json({
      ok: true,
      customerId: result.customer_id,
      consumed: units,
      balance: buildBalancePayload(result),
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: String(error && error.message || "No se pudo consumir crédito.") });
  }
});

app.post("/api/events/track", RATE_LIMITERS.eventsTrack, async function trackEvent(req, res) {
  const eventName = String(req.body && req.body.eventName || "").trim();
  const payload = req.body && typeof req.body.payload === "object" && req.body.payload ? req.body.payload : {};

  if (!eventName) {
    res.status(400).json({ error: "eventName es obligatorio." });
    return;
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload || {}), "utf8");
  if (payloadBytes > 16 * 1024) {
    res.status(413).json({ error: "payload demasiado grande para tracking." });
    return;
  }

  try {
    await withTransaction(async function tx(client) {
      const maybeCustomerId = normalizeCustomerId(req.body && req.body.customerId);
      const user = await resolveUserFromRequest(client, req, maybeCustomerId, { createIfMissing: false });
      await recordEvent(client, eventName, user ? user.id : null, user ? user.customer_id : maybeCustomerId, payload);
    });
    res.status(202).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "No se pudo registrar evento.", detail: String(error && error.message || error) });
  }
});

app.post("/api/ai/generate", RATE_LIMITERS.aiGenerate, async function generateWithAI(req, res) {
  if (!CONFIG.openaiKey) {
    res.status(503).json({ error: "OPENAI_API_KEY no configurada en servidor." });
    return;
  }

  const input = String(req.body && req.body.input || "").trim();
  const promptBase = String(req.body && req.body.systemPrompt || "Eres un editor experto en textos en español.").trim();
  const instructions = String(req.body && req.body.instructions || "").trim();
  const narrativeStyle = normalizeNarrativeStyle(req.body && req.body.style);
  const stylePrompt = buildNarrativeStylePrompt(narrativeStyle);
  const systemPrompt = [
    promptBase,
    instructions,
    stylePrompt,
    "Antes de responder, valida internamente ortografía, coherencia y fidelidad al texto original.",
  ].filter(Boolean).join(" ");
  const userPrompt = String(req.body && req.body.userPrompt || input).trim();
  const requestedModel = String(req.body && req.body.model || CONFIG.openaiModel).trim() || CONFIG.openaiModel;
  const requestedTemperature = Number(req.body && req.body.temperature);
  const temperature = Number.isFinite(requestedTemperature)
    ? clampNumber(requestedTemperature, 0, 1)
    : defaultTemperatureForStyle(narrativeStyle);

  if (!input) {
    res.status(400).json({ error: "input es obligatorio." });
    return;
  }
  if (input.length > 32000) {
    res.status(413).json({ error: "input excede límite de 32000 caracteres." });
    return;
  }
  if (userPrompt.length > 40000) {
    res.status(413).json({ error: "prompt excede límite permitido." });
    return;
  }

  let billed = null;

  try {
    const actor = await withTransaction(async function tx(client) {
      const metadataCustomer = normalizeCustomerId(req.body && req.body.metadata && req.body.metadata.customerId);
      const bodyCustomer = normalizeCustomerId(req.body && req.body.customerId);
        const user = await resolveUserFromRequest(client, req, metadataCustomer || bodyCustomer, {
          createIfMissing: true,
          allowGeneratedCustomer: false,
        });
        if (!user) {
          throw createError("customerId o sesión autenticada requerida para generar.", 400);
        }
      const billing = await consumeGenerationQuota(client, user.id);
      await recordEvent(client, "generation_billed", user.id, user.customer_id, {
        source: billing.source,
        style: narrativeStyle,
      });
      const refreshed = await getUserById(client, user.id);
      billed = { source: billing.source, userId: user.id };
      return refreshed;
    });

    const response = await fetch(trimTrailingSlash(CONFIG.openaiBase) + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + CONFIG.openaiKey,
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
      const reason = extractOutput(json) || rawText || ("HTTP " + response.status);
      throw createError("Fallo en proveedor IA: " + reason, response.status);
    }

    const output = extractOutput(json);
    if (!output) {
      throw createError("Proveedor IA no devolvió contenido.", 502);
    }

    res.json({
      output: output,
      model: (json && json.model) || requestedModel,
      provider: "openai_compat",
      usage: json && json.usage ? json.usage : null,
      billing: {
        source: billed && billed.source ? billed.source : "unknown",
      },
      style: narrativeStyle,
      balance: buildBalancePayload(actor),
    });
  } catch (error) {
    if (billed && billed.userId) {
      try {
        await withTransaction(async function tx(client) {
          await rollbackGenerationQuota(client, billed.userId, billed.source);
        });
      } catch (_rollbackError) {
        // Ignore rollback failures in response path.
      }
    }

    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: String(error && error.message || "No se pudo completar generación IA.") });
  }
});

app.get("/api/admin/metrics", requireAdmin, RATE_LIMITERS.adminRead, async function adminMetrics(req, res) {
  const days = Math.max(1, Math.min(365, toPositiveInt(req.query && req.query.days, 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const summary = await withTransaction(async function tx(client) {
      const userStats = await client.query(
        "SELECT COUNT(*)::int AS total_users, COALESCE(SUM(CASE WHEN provider <> 'anonymous' OR email IS NOT NULL OR google_sub IS NOT NULL THEN 1 ELSE 0 END),0)::int AS authenticated_users FROM app_users"
      );
      const creditsStats = await client.query(
        "SELECT COALESCE(SUM(CASE WHEN total_purchased > 0 THEN 1 ELSE 0 END),0)::int AS paying_users, COALESCE(SUM(CASE WHEN subscription_active THEN 1 ELSE 0 END),0)::int AS active_subscriptions, COALESCE(SUM(credits),0)::int AS total_credits_remaining FROM user_credits"
      );
      const revenueStats = await client.query(
        "SELECT COALESCE(SUM(amount_total),0)::bigint AS revenue_cents, COUNT(*)::int AS completed_payments FROM payment_sessions WHERE status = 'completed'"
      );
      const legalStats = await client.query(
        "SELECT version, COUNT(DISTINCT user_id)::int AS accepted_users FROM legal_consents GROUP BY version ORDER BY version DESC"
      );
      const eventsStats = await client.query(
        "SELECT event_name, COUNT(*)::int AS total FROM app_events WHERE created_at >= $1 GROUP BY event_name ORDER BY total DESC",
        [since.toISOString()]
      );
      const actionStats = await client.query(
        "SELECT COALESCE(payload->>'action','unknown') AS action, COUNT(*)::int AS total FROM app_events WHERE event_name = 'generation_completed' AND created_at >= $1 GROUP BY action ORDER BY total DESC LIMIT 10",
        [since.toISOString()]
      );
      const dailyEvents = await client.query(
        "SELECT CAST(created_at AS DATE) AS day, event_name, COUNT(*)::int AS total FROM app_events WHERE created_at >= $1 GROUP BY day, event_name ORDER BY day ASC, event_name ASC",
        [since.toISOString()]
      );
      const dailyRevenue = await client.query(
        "SELECT CAST(created_at AS DATE) AS day, COALESCE(SUM(amount_total),0)::bigint AS revenue_cents, COUNT(*)::int AS payments FROM payment_sessions WHERE status = 'completed' AND created_at >= $1 GROUP BY day ORDER BY day ASC",
        [since.toISOString()]
      );

      return {
        users: userStats.rows[0],
        credits: creditsStats.rows[0],
        revenue: revenueStats.rows[0],
        legalConsents: legalStats.rows,
        events: eventsStats.rows,
        topActions: actionStats.rows,
        dailyEvents: dailyEvents.rows,
        dailyRevenue: dailyRevenue.rows,
      };
    });

    const eventMap = summary.events.reduce(function reduceEvents(acc, row) {
      acc[row.event_name] = Number(row.total || 0);
      return acc;
    }, {});

    const checkoutStarted = Number(eventMap.checkout_started || 0);
    const checkoutSuccess = Number(eventMap.checkout_success_return || 0);
    const generationCompleted = Number(eventMap.generation_completed || 0);
    const copied = Number(eventMap.result_copied || 0);

    res.json({
      ok: true,
      windowDays: days,
      since: since.toISOString(),
      kpis: {
        totalUsers: Number(summary.users.total_users || 0),
        authenticatedUsers: Number(summary.users.authenticated_users || 0),
        payingUsers: Number(summary.credits.paying_users || 0),
        activeSubscriptions: Number(summary.credits.active_subscriptions || 0),
        legalAcceptedUsersCurrentVersion: Number(
          (summary.legalConsents.find(function findLegal(row) {
            return row.version === CONFIG.legalVersion;
          }) || {}).accepted_users || 0
        ),
        completedPayments: Number(summary.revenue.completed_payments || 0),
        totalCreditsRemaining: Number(summary.credits.total_credits_remaining || 0),
        revenueCents: Number(summary.revenue.revenue_cents || 0),
      },
      funnel: {
        generationCompleted: generationCompleted,
        resultCopied: copied,
        checkoutStarted: checkoutStarted,
        checkoutSuccessReturn: checkoutSuccess,
        checkoutReturnRatePct: checkoutStarted > 0 ? Number(((checkoutSuccess / checkoutStarted) * 100).toFixed(2)) : 0,
        copyRatePct: generationCompleted > 0 ? Number(((copied / generationCompleted) * 100).toFixed(2)) : 0,
      },
      events: summary.events,
      legalConsents: summary.legalConsents,
      topActions: summary.topActions,
      dailyEvents: summary.dailyEvents,
      dailyRevenue: summary.dailyRevenue,
    });
  } catch (error) {
    res.status(500).json({ error: "No se pudieron obtener métricas.", detail: String(error && error.message || error) });
  }
});

app.post("/api/admin/credits/grant", requireAdmin, RATE_LIMITERS.adminWrite, async function grantCredits(req, res) {
  const requestedCredits = toPositiveInt(req.body && req.body.credits, 0);
  if (requestedCredits <= 0 || requestedCredits > 100000) {
    res.status(400).json({ error: "credits debe estar entre 1 y 100000." });
    return;
  }

  try {
    const user = await withTransaction(async function tx(client) {
      var target = null;
      const targetUserId = String(req.body && req.body.userId || "").trim();
      const targetCustomerId = normalizeCustomerId(req.body && req.body.customerId);

      if (targetUserId) {
        target = await getUserById(client, targetUserId);
      }
      if (!target && targetCustomerId) {
        target = await getUserByCustomerId(client, targetCustomerId);
      }
      if (!target && targetCustomerId) {
        target = await ensureUserByCustomerId(client, targetCustomerId);
      }
      if (!target) {
        throw createError("No se encontró usuario objetivo para acreditar.", 404);
      }

      await client.query(
        "UPDATE user_credits SET credits = credits + $2::int, total_purchased = total_purchased + $2::int, updated_at = NOW() WHERE user_id = $1",
        [target.id, requestedCredits]
      );
      await recordEvent(client, "admin_credits_granted", target.id, target.customer_id, {
        credits: requestedCredits,
      });
      return getUserById(client, target.id);
    });

    res.json({
      ok: true,
      granted: requestedCredits,
      user: publicUser(user),
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: String(error && error.message || "No se pudieron acreditar créditos.") });
  }
});

app.post("/api/admin/reconcile/payments", requireAdmin, RATE_LIMITERS.adminWrite, async function reconcilePayments(req, res) {
  if (!stripe) {
    res.status(503).json({ error: "Stripe no configurado." });
    return;
  }

  const requestedSessionId = String(req.body && req.body.sessionId || "").trim();
  const limit = Math.max(1, Math.min(100, toPositiveInt(req.body && req.body.limit, 25)));

  try {
    const pendingRows = await withTransaction(async function tx(client) {
      if (requestedSessionId) {
        const one = await client.query(
          "SELECT session_id FROM payment_sessions WHERE session_id = $1",
          [requestedSessionId]
        );
        return one.rows;
      }
      const many = await client.query(
        "SELECT session_id FROM payment_sessions WHERE status IN ('created','pending') ORDER BY created_at DESC LIMIT $1",
        [limit]
      );
      return many.rows;
    });

    const results = [];

    for (let i = 0; i < pendingRows.length; i += 1) {
      const sessionId = pendingRows[i].session_id;
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session && (session.payment_status === "paid" || session.status === "complete")) {
          await withTransaction(async function tx(client) {
            await processCheckoutCompleted(client, session);
          });
          results.push({ sessionId: sessionId, status: "reconciled" });
        } else {
          results.push({ sessionId: sessionId, status: "pending" });
        }
      } catch (error) {
        results.push({ sessionId: sessionId, status: "error", detail: String(error && error.message || error) });
      }
    }

    res.json({
      ok: true,
      requested: pendingRows.length,
      reconciled: results.filter(function filterOk(item) { return item.status === "reconciled"; }).length,
      pending: results.filter(function filterPending(item) { return item.status === "pending"; }).length,
      failed: results.filter(function filterFail(item) { return item.status === "error"; }).length,
      details: results,
    });
  } catch (error) {
    res.status(500).json({ error: "No se pudo reconciliar pagos.", detail: String(error && error.message || error) });
  }
});

app.use(function errorHandler(err, req, res, _next) {
  logError("request.error", {
    requestId: req && req.requestId ? req.requestId : null,
    method: req && req.method ? req.method : null,
    path: req && req.originalUrl ? req.originalUrl : null,
    message: String(err && err.message || err),
  });
  res.status(500).json({
    error: "Error interno.",
    detail: String(err && err.message || err),
    requestId: req && req.requestId ? req.requestId : null,
  });
});

let serverInstance = null;
let hasMigrated = false;
let poolClosed = false;

async function startServer(options) {
  const opts = options && typeof options === "object" ? options : {};
  const port = Number.isFinite(Number(opts.port)) ? Number(opts.port) : CONFIG.port;
  const host = typeof opts.host === "string" && opts.host ? opts.host : "0.0.0.0";

  if (serverInstance) {
    const address = serverInstance.address();
    return {
      app: app,
      server: serverInstance,
      port: address && address.port ? address.port : port,
      host: host,
      provider: DB_PROVIDER,
    };
  }
  if (poolClosed) {
    throw new Error("Pool ya fue cerrado; reinicia el proceso para volver a arrancar.");
  }

  if (!hasMigrated) {
    await runMigrations();
    hasMigrated = true;
  }

  await new Promise(function listenPromise(resolve, reject) {
    serverInstance = app.listen(port, host, function onListen() {
      resolve();
    });
    serverInstance.once("error", function onError(error) {
      reject(error);
    });
  });

  const address = serverInstance.address();
  return {
    app: app,
    server: serverInstance,
    port: address && address.port ? address.port : port,
    host: host,
    provider: DB_PROVIDER,
  };
}

async function stopServer() {
  if (serverInstance) {
    await new Promise(function closePromise(resolve, reject) {
      serverInstance.close(function onClose(error) {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    serverInstance = null;
  }

  if (!poolClosed) {
    await pool.end();
    poolClosed = true;
  }
}

function createMailer() {
  if (!CONFIG.smtpHost) {
    return null;
  }
  return nodemailer.createTransport({
    host: CONFIG.smtpHost,
    port: CONFIG.smtpPort,
    secure: CONFIG.smtpSecure,
    auth: CONFIG.smtpUser && CONFIG.smtpPass
      ? { user: CONFIG.smtpUser, pass: CONFIG.smtpPass }
      : undefined,
  });
}

async function deliverOTPEmail(email, code, expiresAt) {
  if (!mailer) {
    console.info("[dev-otp] email=%s code=%s expires=%s", email, code, expiresAt.toISOString());
    return "dev-log";
  }

  await mailer.sendMail({
    from: CONFIG.smtpFrom,
    to: email,
    subject: "Tu código de acceso a Simplify",
    text: [
      "Tu código de acceso es: " + code,
      "",
      "Este código caduca en " + CONFIG.otpTTLMinutes + " minutos.",
      "Si no solicitaste este acceso, ignora este mensaje.",
    ].join("\n"),
  });
  return "smtp";
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
      currency: CONFIG.priceCurrency,
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
        currency: CONFIG.priceCurrency,
        recurring: { interval: "month" },
        unit_amount: plan.unitAmountCents,
        product_data: { name: plan.label },
      },
      quantity: 1,
    }];
  }
  return [{
    price_data: {
      currency: CONFIG.priceCurrency,
      unit_amount: plan.unitAmountCents,
      product_data: { name: plan.label },
    },
    quantity: 1,
  }];
}

function createDatabaseRuntime() {
  if (CONFIG.usePgMem) {
    var pgMem = require("pg-mem");
    var db = pgMem.newDb({ autoCreateForeignKeyIndices: true });
    db.public.registerFunction({
      name: "now",
      returns: "timestamptz",
      implementation: function nowImpl() {
        return new Date();
      },
    });
    var adapter = db.adapters.createPg();
    return {
      provider: "pg-mem",
      pool: new adapter.Pool(),
    };
  }

  if (!CONFIG.databaseURL) {
    throw new Error("DATABASE_URL is required unless USE_PG_MEM=1");
  }

  return {
    provider: "postgres",
    pool: new Pool({
      connectionString: CONFIG.databaseURL,
      ssl: CONFIG.postgresSSL ? { rejectUnauthorized: false } : false,
    }),
  };
}

function createRateLimiter(options) {
  var config = Object.assign({
    name: "rate-limit",
    windowMs: 60 * 1000,
    max: 60,
    keyFn: function defaultKey(req) {
      return getClientKey(req);
    },
  }, options || {});

  var buckets = new Map();
  var cleanupEvery = Math.max(15 * 1000, Math.floor(config.windowMs / 2));
  var lastCleanup = Date.now();

  return function limiter(req, res, next) {
    var now = Date.now();
    if ((now - lastCleanup) > cleanupEvery) {
      buckets.forEach(function eachBucket(value, key) {
        if (!value || value.resetAt <= now) {
          buckets.delete(key);
        }
      });
      lastCleanup = now;
    }

    var key = String(config.keyFn(req) || "");
    if (!key) {
      key = getClientKey(req);
    }
    var bucketKey = config.name + ":" + key;
    var bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = {
        count: 0,
        resetAt: now + config.windowMs,
      };
      buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    if (bucket.count > config.max) {
      var retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Demasiadas solicitudes. Intenta de nuevo en unos segundos.",
        limiter: config.name,
      });
      return;
    }
    next();
  };
}

async function runMigrations() {
  const ddl = [
    "CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, customer_id TEXT UNIQUE NOT NULL, email TEXT UNIQUE, name TEXT, role TEXT NOT NULL DEFAULT 'user', provider TEXT NOT NULL DEFAULT 'anonymous', google_sub TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_app_users_customer_id ON app_users(customer_id)",
    "CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email)",
    "CREATE TABLE IF NOT EXISTS user_credits (user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE, credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0), free_used INTEGER NOT NULL DEFAULT 0 CHECK (free_used >= 0), free_uses INTEGER NOT NULL DEFAULT 3 CHECK (free_uses >= 0), total_purchased INTEGER NOT NULL DEFAULT 0 CHECK (total_purchased >= 0), total_consumed INTEGER NOT NULL DEFAULT 0 CHECK (total_consumed >= 0), subscription_active BOOLEAN NOT NULL DEFAULT FALSE, subscription_credits_cycle INTEGER NOT NULL DEFAULT 250 CHECK (subscription_credits_cycle >= 0), stripe_customer_id TEXT UNIQUE, stripe_subscription_id TEXT UNIQUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS payment_sessions (session_id TEXT PRIMARY KEY, user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL, customer_id TEXT NOT NULL, plan_id TEXT NOT NULL, status TEXT NOT NULL, amount_total INTEGER, currency TEXT NOT NULL, credits_granted INTEGER NOT NULL DEFAULT 0, granted BOOLEAN NOT NULL DEFAULT FALSE, stripe_customer_id TEXT, stripe_subscription_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_user ON payment_sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_status ON payment_sessions(status)",
    "CREATE TABLE IF NOT EXISTS processed_invoices (invoice_id TEXT PRIMARY KEY, user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, payload JSONB NOT NULL, processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS email_login_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS app_events (id BIGSERIAL PRIMARY KEY, event_name TEXT NOT NULL, user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL, customer_id TEXT, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_app_events_created_at ON app_events(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_app_events_event_name ON app_events(event_name)",
    "CREATE TABLE IF NOT EXISTS legal_consents (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, customer_id TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'web', accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), user_agent TEXT, ip_hash TEXT)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_consents_user_version ON legal_consents(user_id, version)",
    "CREATE INDEX IF NOT EXISTS idx_legal_consents_customer_version ON legal_consents(customer_id, version)",
  ];

  for (let i = 0; i < ddl.length; i += 1) {
    await pool.query(ddl[i]);
  }
}

async function withTransaction(worker) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await worker(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const USER_SELECT = [
  "SELECT",
  "u.id, u.customer_id, u.email, u.name, u.role, u.provider, u.google_sub, u.created_at, u.updated_at,",
  "c.credits, c.free_used, c.free_uses, c.total_purchased, c.total_consumed, c.subscription_active,",
  "c.subscription_credits_cycle, c.stripe_customer_id, c.stripe_subscription_id, c.updated_at AS credits_updated_at",
  "FROM app_users u",
  "JOIN user_credits c ON c.user_id = u.id",
].join(" ");

async function getUserById(client, userId) {
  const result = await client.query(USER_SELECT + " WHERE u.id = $1 LIMIT 1", [userId]);
  return result.rowCount ? result.rows[0] : null;
}

async function getUserByCustomerId(client, customerId) {
  const result = await client.query(USER_SELECT + " WHERE u.customer_id = $1 LIMIT 1", [customerId]);
  return result.rowCount ? result.rows[0] : null;
}

async function getUserByEmail(client, email) {
  const result = await client.query(USER_SELECT + " WHERE u.email = $1 LIMIT 1", [email]);
  return result.rowCount ? result.rows[0] : null;
}

async function getUserByGoogleSub(client, googleSub) {
  const result = await client.query(USER_SELECT + " WHERE u.google_sub = $1 LIMIT 1", [googleSub]);
  return result.rowCount ? result.rows[0] : null;
}

async function getUserByStripeCustomer(client, stripeCustomerId) {
  const result = await client.query(USER_SELECT + " WHERE c.stripe_customer_id = $1 LIMIT 1", [stripeCustomerId]);
  return result.rowCount ? result.rows[0] : null;
}

async function getUserByStripeSubscription(client, stripeSubscriptionId) {
  const result = await client.query(USER_SELECT + " WHERE c.stripe_subscription_id = $1 LIMIT 1", [stripeSubscriptionId]);
  return result.rowCount ? result.rows[0] : null;
}

async function ensureUserByCustomerId(client, rawCustomerId) {
  const customerId = normalizeCustomerId(rawCustomerId);
  if (!customerId) {
    throw createError("customerId inválido.", 400);
  }

  let user = await getUserByCustomerId(client, customerId);
  if (user) {
    return user;
  }

  const userId = crypto.randomUUID();
  await client.query(
    "INSERT INTO app_users (id, customer_id, provider, created_at, updated_at) VALUES ($1,$2,'anonymous',NOW(),NOW())",
    [userId, customerId]
  );
  await client.query(
    "INSERT INTO user_credits (user_id, credits, free_used, free_uses, total_purchased, total_consumed, subscription_active, subscription_credits_cycle, updated_at) VALUES ($1,0,0,$2,0,0,false,$3,NOW())",
    [userId, CONFIG.freeUses, CONFIG.creditSubMonth]
  );

  user = await getUserById(client, userId);
  return user;
}

async function resolveUserFromRequest(client, req, providedCustomerId, options) {
  const opts = Object.assign({ createIfMissing: true, allowGeneratedCustomer: true }, options || {});
  if (req.authUser) {
    return req.authUser;
  }

  const incomingCustomerId = normalizeCustomerId(providedCustomerId);
  if (!incomingCustomerId) {
    if (!opts.allowGeneratedCustomer) {
      return null;
    }
    if (opts.createIfMissing) {
      return ensureUserByCustomerId(client, generateCustomerId());
    }
    return null;
  }

  const existing = await getUserByCustomerId(client, incomingCustomerId);
  if (existing) {
    return existing;
  }

  if (!opts.createIfMissing) {
    return null;
  }

  return ensureUserByCustomerId(client, incomingCustomerId);
}

async function mergeUsers(client, sourceUserId, targetUserId) {
  if (sourceUserId === targetUserId) {
    return;
  }

  const source = await getUserById(client, sourceUserId);
  const target = await getUserById(client, targetUserId);
  if (!source || !target) {
    return;
  }

  await client.query(
    [
      "UPDATE user_credits AS t SET",
      "credits = t.credits + s.credits,",
      "free_used = LEAST(t.free_used, s.free_used),",
      "free_uses = GREATEST(t.free_uses, s.free_uses),",
      "total_purchased = t.total_purchased + s.total_purchased,",
      "total_consumed = t.total_consumed + s.total_consumed,",
      "subscription_active = t.subscription_active OR s.subscription_active,",
      "subscription_credits_cycle = GREATEST(t.subscription_credits_cycle, s.subscription_credits_cycle),",
      "stripe_customer_id = COALESCE(t.stripe_customer_id, s.stripe_customer_id),",
      "stripe_subscription_id = COALESCE(t.stripe_subscription_id, s.stripe_subscription_id),",
      "updated_at = NOW()",
      "FROM user_credits AS s",
      "WHERE t.user_id = $1 AND s.user_id = $2",
    ].join(" "),
    [targetUserId, sourceUserId]
  );

  await client.query("UPDATE payment_sessions SET user_id = $1, customer_id = $2, updated_at = NOW() WHERE user_id = $3", [
    targetUserId, target.customer_id, sourceUserId,
  ]);
  await client.query("UPDATE app_events SET user_id = $1 WHERE user_id = $2", [targetUserId, sourceUserId]);
  await client.query("UPDATE processed_invoices SET user_id = $1 WHERE user_id = $2", [targetUserId, sourceUserId]);
  await client.query("DELETE FROM user_credits WHERE user_id = $1", [sourceUserId]);
  await client.query("DELETE FROM app_users WHERE id = $1", [sourceUserId]);
}

async function hasLegalConsent(client, userId, version) {
  const result = await client.query(
    "SELECT id FROM legal_consents WHERE user_id = $1 AND version = $2 LIMIT 1",
    [userId, version]
  );
  return result.rowCount > 0;
}

async function upsertLegalConsent(client, user, version, source, req) {
  const normalizedVersion = normalizeLegalVersion(version) || CONFIG.legalVersion;
  const normalizedSource = normalizeLegalSource(source) || "web";
  const userAgent = String(req && req.headers && req.headers["user-agent"] || "")
    .trim()
    .slice(0, 240);
  const ipHash = hashForStorage(String(req && req.ip || req && req.socket && req.socket.remoteAddress || ""));

  await client.query(
    "INSERT INTO legal_consents (user_id, customer_id, version, source, accepted_at, user_agent, ip_hash) VALUES ($1,$2,$3,$4,NOW(),$5,$6) ON CONFLICT (user_id, version) DO UPDATE SET customer_id = EXCLUDED.customer_id, source = EXCLUDED.source, accepted_at = NOW(), user_agent = EXCLUDED.user_agent, ip_hash = EXCLUDED.ip_hash",
    [user.id, user.customer_id, normalizedVersion, normalizedSource, userAgent || null, ipHash || null]
  );
}

async function recordEvent(client, eventName, userId, customerId, payload) {
  await client.query(
    "INSERT INTO app_events (event_name, user_id, customer_id, payload, created_at) VALUES ($1,$2,$3,$4::jsonb,NOW())",
    [eventName, userId || null, customerId || null, JSON.stringify(payload || {})]
  );
}

async function consumeGenerationQuota(client, userId) {
  const rowResult = await client.query(
    "SELECT credits, free_used, free_uses FROM user_credits WHERE user_id = $1 FOR UPDATE",
    [userId]
  );
  if (rowResult.rowCount === 0) {
    throw createError("Usuario de facturación no encontrado.", 404);
  }
  const row = rowResult.rows[0];
  const freeUsed = Number(row.free_used || 0);
  const freeUses = Number(row.free_uses || CONFIG.freeUses);
  const credits = Number(row.credits || 0);

  if (freeUsed < freeUses) {
    await client.query(
      "UPDATE user_credits SET free_used = free_used + 1, updated_at = NOW() WHERE user_id = $1",
      [userId]
    );
    return { source: "free" };
  }

  if (credits > 0) {
    await client.query(
      "UPDATE user_credits SET credits = credits - 1, total_consumed = total_consumed + 1, updated_at = NOW() WHERE user_id = $1",
      [userId]
    );
    return { source: "credit" };
  }

  throw createError("Créditos insuficientes.", 402);
}

async function rollbackGenerationQuota(client, userId, source) {
  if (source === "free") {
    await client.query(
      "UPDATE user_credits SET free_used = GREATEST(0, free_used - 1), updated_at = NOW() WHERE user_id = $1",
      [userId]
    );
    return;
  }
  if (source === "credit") {
    await client.query(
      "UPDATE user_credits SET credits = credits + 1, total_consumed = GREATEST(0, total_consumed - 1), updated_at = NOW() WHERE user_id = $1",
      [userId]
    );
  }
}

async function processCheckoutCompleted(client, session) {
  const metadata = session && session.metadata ? session.metadata : {};
  const metadataUserId = String(metadata.user_id || "").trim();
  const metadataCustomerId = normalizeCustomerId(metadata.customer_id);
  const metadataPlan = String(metadata.plan || "").trim();
  const metadataCredits = Number(metadata.credits_granted);

  let user = null;
  if (metadataUserId) {
    user = await getUserById(client, metadataUserId);
  }
  if (!user && metadataCustomerId) {
    user = await ensureUserByCustomerId(client, metadataCustomerId);
  }
  if (!user && session && session.customer) {
    user = await getUserByStripeCustomer(client, String(session.customer));
  }
  if (!user) {
    return;
  }

  const plan = PLAN_CONFIG[metadataPlan] || null;
  const creditsGranted = Number.isFinite(metadataCredits)
    ? Math.max(0, Math.floor(metadataCredits))
    : (plan ? plan.credits : 0);

  const existingPayment = await client.query("SELECT granted FROM payment_sessions WHERE session_id = $1", [session.id]);
  const alreadyGranted = existingPayment.rowCount > 0 && Boolean(existingPayment.rows[0].granted);
  const grantedFlag = alreadyGranted || creditsGranted > 0;

  await client.query(
    "INSERT INTO payment_sessions (session_id, user_id, customer_id, plan_id, status, amount_total, currency, credits_granted, granted, stripe_customer_id, stripe_subscription_id, created_at, updated_at) VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,$8,$9,$10,NOW(),NOW()) ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id, customer_id = EXCLUDED.customer_id, plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, amount_total = EXCLUDED.amount_total, currency = EXCLUDED.currency, credits_granted = EXCLUDED.credits_granted, granted = EXCLUDED.granted, stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = EXCLUDED.stripe_subscription_id, updated_at = NOW()",
    [
      session.id,
      user.id,
      user.customer_id,
      metadataPlan || "",
      session.amount_total || null,
      session.currency || CONFIG.priceCurrency,
      creditsGranted,
      grantedFlag,
      session.customer || null,
      session.subscription || null,
    ]
  );

  if (session.customer || session.subscription) {
    await client.query(
      "UPDATE user_credits SET stripe_customer_id = COALESCE($2, stripe_customer_id), stripe_subscription_id = COALESCE($3, stripe_subscription_id), subscription_active = CASE WHEN $3 IS NULL THEN subscription_active ELSE true END, subscription_credits_cycle = CASE WHEN $4 > 0 THEN $4 ELSE subscription_credits_cycle END, updated_at = NOW() WHERE user_id = $1",
      [user.id, session.customer || null, session.subscription || null, creditsGranted]
    );
  }

  if (!alreadyGranted && creditsGranted > 0) {
    await client.query(
      "UPDATE user_credits SET credits = credits + $2::int, total_purchased = total_purchased + $2::int, updated_at = NOW() WHERE user_id = $1",
      [user.id, creditsGranted]
    );
  }

  await recordEvent(client, "checkout_session_completed", user.id, user.customer_id, {
    sessionId: session.id,
    plan: metadataPlan || "",
    creditsGranted: creditsGranted,
  });
}

async function processInvoicePaid(client, invoice) {
  const invoiceId = String(invoice && invoice.id || "").trim();
  const stripeCustomerId = String(invoice && invoice.customer || "").trim();
  const billingReason = String(invoice && invoice.billing_reason || "").trim();
  if (!invoiceId || !stripeCustomerId) {
    return;
  }

  const inserted = await client.query(
    "INSERT INTO processed_invoices (invoice_id, user_id, created_at) VALUES ($1,NULL,NOW()) ON CONFLICT (invoice_id) DO NOTHING RETURNING invoice_id",
    [invoiceId]
  );
  if (inserted.rowCount === 0) {
    return;
  }

  const user = await getUserByStripeCustomer(client, stripeCustomerId);
  if (!user) {
    return;
  }

  await client.query(
    "UPDATE processed_invoices SET user_id = $2 WHERE invoice_id = $1",
    [invoiceId, user.id]
  );

  await client.query(
    "UPDATE user_credits SET subscription_active = true, updated_at = NOW() WHERE user_id = $1",
    [user.id]
  );

  if (billingReason === "subscription_cycle") {
    await client.query(
      "UPDATE user_credits SET credits = credits + subscription_credits_cycle, total_purchased = total_purchased + subscription_credits_cycle, updated_at = NOW() WHERE user_id = $1",
      [user.id]
    );
  }

  await recordEvent(client, "invoice_paid", user.id, user.customer_id, {
    invoiceId: invoiceId,
    billingReason: billingReason,
  });
}

async function processSubscriptionUpdated(client, subscription) {
  const subscriptionId = String(subscription && subscription.id || "").trim();
  if (!subscriptionId) {
    return;
  }
  const status = String(subscription && subscription.status || "").trim();
  const active = status === "active" || status === "trialing" || status === "past_due";
  const user = await getUserByStripeSubscription(client, subscriptionId);
  if (!user) {
    return;
  }
  await client.query(
    "UPDATE user_credits SET subscription_active = $2, updated_at = NOW() WHERE user_id = $1",
    [user.id, active]
  );
  await recordEvent(client, "subscription_updated", user.id, user.customer_id, {
    subscriptionId: subscriptionId,
    status: status,
    active: active,
  });
}

async function processSubscriptionDeleted(client, subscription) {
  const subscriptionId = String(subscription && subscription.id || "").trim();
  if (!subscriptionId) {
    return;
  }
  const user = await getUserByStripeSubscription(client, subscriptionId);
  if (!user) {
    return;
  }
  await client.query(
    "UPDATE user_credits SET subscription_active = false, updated_at = NOW() WHERE user_id = $1",
    [user.id]
  );
  await recordEvent(client, "subscription_deleted", user.id, user.customer_id, {
    subscriptionId: subscriptionId,
  });
}

async function authOptional(req, _res, next) {
  const token = getBearerToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const decoded = jwt.verify(token, CONFIG.jwtSecret);
    if (!decoded || typeof decoded !== "object" || !decoded.sub) {
      next();
      return;
    }

    const user = await withTransaction(async function tx(client) {
      return getUserById(client, String(decoded.sub));
    });

    if (!user) {
      next();
      return;
    }

    req.auth = decoded;
    req.authUser = user;
    next();
  } catch (_error) {
    next();
  }
}

function requireAuth(req, res, next) {
  if (!req.authUser) {
    res.status(401).json({ error: "Autenticación requerida." });
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  const headerKey = String(req.headers["x-admin-key"] || "").trim();
  const headerMatch = Boolean(CONFIG.adminAPIKey) && headerKey && headerKey === CONFIG.adminAPIKey;
  const roleMatch = req.authUser && req.authUser.role === "admin";
  if (!headerMatch && !roleMatch) {
    res.status(403).json({ error: "Acceso admin requerido." });
    return;
  }
  next();
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) {
    return "";
  }
  return header.slice("Bearer ".length).trim();
}

function buildSessionResponse(user) {
  const token = jwt.sign(
    {
      sub: user.id,
      role: user.role,
      customerId: user.customer_id,
      email: user.email || null,
      provider: user.provider,
    },
    CONFIG.jwtSecret,
    { expiresIn: CONFIG.jwtExpiresIn }
  );

  return {
    ok: true,
    token: token,
    user: publicUser(user),
  };
}

function publicUser(user) {
  return {
    id: user.id,
    customerId: user.customer_id,
    email: user.email || null,
    name: user.name || null,
    role: user.role || "user",
    provider: user.provider || "anonymous",
    balance: buildBalancePayload(user),
  };
}

function buildBalancePayload(user) {
  const freeUses = Number(user.free_uses || CONFIG.freeUses);
  const freeUsed = Number(user.free_used || 0);
  const freeLeft = Math.max(0, freeUses - freeUsed);
  return {
    credits: Math.max(0, Number(user.credits || 0)),
    freeUses: freeUses,
    freeUsed: freeUsed,
    freeLeft: freeLeft,
    totalPurchased: Math.max(0, Number(user.total_purchased || 0)),
    totalConsumed: Math.max(0, Number(user.total_consumed || 0)),
    subscriptionActive: Boolean(user.subscription_active),
    stripeCustomerId: user.stripe_customer_id || null,
    stripeSubscriptionId: user.stripe_subscription_id || null,
    updatedAt: user.credits_updated_at || user.updated_at || new Date().toISOString(),
  };
}

function generateCustomerId() {
  return "cust_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

function normalizeCustomerId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 96);
  return normalized || "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDisplayName(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, 120);
}

function normalizeLegalVersion(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 40);
  return normalized || "";
}

function normalizeLegalSource(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 64);
  return normalized || "";
}

function hashForStorage(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function normalizeNarrativeStyle(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "executive" ||
    normalized === "technical" ||
    normalized === "academic" ||
    normalized === "storytelling" ||
    normalized === "persuasive" ||
    normalized === "creative"
  ) {
    return normalized;
  }
  return "neutral";
}

function buildNarrativeStylePrompt(style) {
  const normalized = normalizeNarrativeStyle(style);
  if (normalized === "executive") {
    return "Estilo narrativo objetivo: ejecutivo. Responde con foco en decisiones, prioridades y acciones.";
  }
  if (normalized === "technical") {
    return "Estilo narrativo objetivo: técnico. Mantén precisión terminológica y estructura clara.";
  }
  if (normalized === "academic") {
    return "Estilo narrativo objetivo: académico. Mantén rigor, cohesión argumental y tono formal.";
  }
  if (normalized === "storytelling") {
    return "Estilo narrativo objetivo: storytelling. Organiza la respuesta con inicio, desarrollo y cierre.";
  }
  if (normalized === "persuasive") {
    return "Estilo narrativo objetivo: persuasivo. Refuerza beneficios y cierra con llamada a la acción concreta.";
  }
  if (normalized === "creative") {
    return "Estilo narrativo objetivo: creativo. Aporta originalidad sin perder claridad ni exactitud.";
  }
  return "Estilo narrativo objetivo: neutro claro.";
}

function defaultTemperatureForStyle(style) {
  const normalized = normalizeNarrativeStyle(style);
  if (normalized === "creative" || normalized === "storytelling") {
    return 0.45;
  }
  if (normalized === "technical" || normalized === "academic") {
    return 0.15;
  }
  return 0.2;
}

function clampNumber(value, minValue, maxValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return minValue;
  }
  return Math.min(maxValue, Math.max(minValue, parsed));
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function generateOTPCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOTPCode(email, code) {
  return crypto
    .createHash("sha256")
    .update(String(email) + ":" + String(code) + ":" + CONFIG.otpPepper)
    .digest("hex");
}

function createError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requestContextMiddleware(req, res, next) {
  var incoming = String(req && req.headers && req.headers["x-request-id"] || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "")
    .slice(0, 128);
  var requestId = incoming || crypto.randomUUID();
  req.requestId = requestId;

  var startTime = process.hrtime.bigint();
  res.setHeader("x-request-id", requestId);

  res.on("finish", function onFinish() {
    var durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
    logInfo("request.completed", {
      requestId: requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    });
  });

  next();
}

function securityHeadersMiddleware(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (isHttpsRequest(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  next();
}

function isHttpsRequest(req) {
  if (!req) {
    return false;
  }
  if (req.secure) {
    return true;
  }
  var forwardedProto = String(req.headers && req.headers["x-forwarded-proto"] || "").toLowerCase();
  return forwardedProto.split(",")[0].trim() === "https";
}

function logInfo(event, payload) {
  logStructured("info", event, payload);
}

function logError(event, payload) {
  logStructured("error", event, payload);
}

function logStructured(level, event, payload) {
  var record = Object.assign({
    ts: new Date().toISOString(),
    level: level,
    event: event,
  }, payload || {});
  try {
    console.log(JSON.stringify(record));
  } catch (_error) {
    console.log("[log-fallback]", level, event);
  }
}

function readNumber(name, fallback) {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function getClientKey(req) {
  var forwarded = String(req && req.headers && req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  var ip = forwarded || String(req && req.ip || req && req.socket && req.socket.remoteAddress || "unknown");
  var authUser = req && req.authUser && req.authUser.id ? String(req.authUser.id) : "";
  return authUser ? (ip + ":" + authUser) : ip;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function verifyGoogleIdToken(idToken, expectedAudience) {
  const token = String(idToken || "").trim();
  if (!token) {
    throw createError("Google idToken vacío.", 400);
  }

  const response = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), {
    method: "GET",
  });
  if (!response.ok) {
    throw createError("Google token inválido.", 401);
  }

  const payload = await response.json();
  const audience = String(payload && payload.aud || "").trim();
  const expires = Number(payload && payload.exp);
  if (!audience || audience !== expectedAudience) {
    throw createError("Google token con audiencia inválida.", 401);
  }
  if (!Number.isFinite(expires) || (expires * 1000) < Date.now()) {
    throw createError("Google token expirado.", 401);
  }

  return {
    sub: String(payload && payload.sub || "").trim(),
    email: String(payload && payload.email || "").trim(),
    email_verified: String(payload && payload.email_verified || "").toLowerCase() === "true",
    name: String(payload && payload.name || "").trim(),
  };
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

if (require.main === module) {
  startServer().then(function onStarted(details) {
    console.log("[simplify-backend] listening on port " + details.port + " (" + details.provider + ")");
  }).catch(function fatal(error) {
    console.error("[fatal] startup error", error);
    process.exit(1);
  });
}

module.exports = {
  app: app,
  pool: pool,
  CONFIG: CONFIG,
  startServer: startServer,
  stopServer: stopServer,
  runMigrations: runMigrations,
};
