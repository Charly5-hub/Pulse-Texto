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
  marketingSpendMonthlyCents: readNumber("MARKETING_SPEND_MONTHLY_CENTS", 0),
  recoverySweepMinutes: Math.max(1, readNumber("RECOVERY_SWEEP_MINUTES", 15)),
  recoveryDelayMinutes: Math.max(1, readNumber("RECOVERY_DELAY_MINUTES", 45)),
  recoveryMaxAttempts: Math.max(1, readNumber("RECOVERY_MAX_ATTEMPTS", 2)),
  recoveryBatchSize: Math.max(1, Math.min(100, readNumber("RECOVERY_BATCH_SIZE", 25))),
  maxInputFree: Math.max(500, readNumber("MAX_INPUT_FREE", 8000)),
  maxInputOne: Math.max(1000, readNumber("MAX_INPUT_ONE", 12000)),
  maxInputPack: Math.max(1000, readNumber("MAX_INPUT_PACK", 20000)),
  maxInputSub: Math.max(1000, readNumber("MAX_INPUT_SUB", 32000)),
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

const PLAN_TIER_ORDER = {
  free: 0,
  one: 1,
  pack: 2,
  sub: 3,
};

const PLAN_LIMITS = {
  free: { maxInputChars: CONFIG.maxInputFree },
  one: { maxInputChars: CONFIG.maxInputOne },
  pack: { maxInputChars: CONFIG.maxInputPack },
  sub: { maxInputChars: CONFIG.maxInputSub },
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
      recovery: {
        sweepMinutes: CONFIG.recoverySweepMinutes,
        delayMinutes: CONFIG.recoveryDelayMinutes,
        maxAttempts: CONFIG.recoveryMaxAttempts,
      },
      planLimits: PLAN_LIMITS,
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
    limits: PLAN_LIMITS,
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
  if (input.length > PLAN_LIMITS.sub.maxInputChars) {
    res.status(413).json({ error: "input excede límite absoluto permitido." });
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
      const effectivePlanTier = getEffectivePlanTier(user);
      const limits = getPlanLimitsForTier(effectivePlanTier);
      if (input.length > limits.maxInputChars) {
        throw createError(
          "El texto supera el límite de tu plan actual (" + effectivePlanTier + "). Máximo " + limits.maxInputChars + " caracteres.",
          413
        );
      }
      const billing = await consumeGenerationQuota(client, user.id);
      await recordEvent(client, "generation_billed", user.id, user.customer_id, {
        source: billing.source,
        style: narrativeStyle,
        planTier: effectivePlanTier,
      });
      const refreshed = await getUserById(client, user.id);
      billed = { source: billing.source, userId: user.id, planTier: effectivePlanTier };
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
      planTier: billed && billed.planTier ? billed.planTier : "free",
      limits: getPlanLimitsForTier(billed && billed.planTier ? billed.planTier : "free"),
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
      const revenueWindowStats = await client.query(
        "SELECT COALESCE(SUM(amount_total),0)::bigint AS revenue_cents FROM payment_sessions WHERE status = 'completed' AND created_at >= $1",
        [since.toISOString()]
      );
      const newPayingWindowStats = await client.query(
        [
          "SELECT COUNT(*)::int AS total FROM (",
          "SELECT user_id, MIN(created_at) AS first_paid_at",
          "FROM payment_sessions",
          "WHERE status = 'completed' AND user_id IS NOT NULL",
          "GROUP BY user_id",
          ") x",
          "WHERE first_paid_at >= $1",
        ].join(" "),
        [since.toISOString()]
      );
      const marketingSpendStats = await client.query(
        "SELECT COALESCE(SUM(amount_cents),0)::bigint AS spend_cents FROM marketing_costs WHERE spent_at >= $1",
        [since.toISOString()]
      );
      const legalStats = await client.query(
        "SELECT version, COUNT(DISTINCT user_id)::int AS accepted_users FROM legal_consents GROUP BY version ORDER BY version DESC"
      );
      const recoveryStats = await client.query(
        "SELECT COALESCE(SUM(CASE WHEN recovery_email_sent_at IS NOT NULL THEN 1 ELSE 0 END),0)::int AS sent, COALESCE(SUM(CASE WHEN recovery_email_sent_at IS NOT NULL AND status = 'completed' THEN 1 ELSE 0 END),0)::int AS converted, COALESCE(SUM(CASE WHEN status IN ('created','pending') AND created_at <= $1 THEN 1 ELSE 0 END),0)::int AS candidates FROM payment_sessions",
        [new Date(Date.now() - CONFIG.recoveryDelayMinutes * 60 * 1000).toISOString()]
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
        revenueWindow: revenueWindowStats.rows[0],
        newPayingWindow: newPayingWindowStats.rows[0],
        marketingSpendWindow: marketingSpendStats.rows[0],
        legalConsents: legalStats.rows,
        recovery: recoveryStats.rows[0],
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
    const totalRevenueCents = Number(summary.revenue.revenue_cents || 0);
    const payingUsers = Number(summary.credits.paying_users || 0);
    const ltvCents = payingUsers > 0 ? Math.round(totalRevenueCents / payingUsers) : 0;
    const windowRevenueCents = Number(summary.revenueWindow.revenue_cents || 0);
    const windowNewPayingUsers = Number(summary.newPayingWindow.total || 0);
    const explicitMarketingSpend = Number(summary.marketingSpendWindow.spend_cents || 0);
    const fallbackSpend = Math.round((Math.max(0, Number(CONFIG.marketingSpendMonthlyCents || 0)) * days) / 30);
    const marketingSpendCents = explicitMarketingSpend > 0 ? explicitMarketingSpend : fallbackSpend;
    const cacCents = windowNewPayingUsers > 0 ? Math.round(marketingSpendCents / windowNewPayingUsers) : 0;
    const ltvCacRatio = cacCents > 0 ? Number((ltvCents / cacCents).toFixed(2)) : 0;
    const recoverySent = Number(summary.recovery.sent || 0);
    const recoveryConverted = Number(summary.recovery.converted || 0);
    const recoveryCandidates = Number(summary.recovery.candidates || 0);

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
      unitEconomics: {
        lifetimeRevenueCents: totalRevenueCents,
        lifetimePayingUsers: payingUsers,
        ltvCents: ltvCents,
        windowRevenueCents: windowRevenueCents,
        windowNewPayingUsers: windowNewPayingUsers,
        marketingSpendCents: marketingSpendCents,
        cacCents: cacCents,
        ltvCacRatio: ltvCacRatio,
      },
      checkoutRecovery: {
        candidates: recoveryCandidates,
        sent: recoverySent,
        converted: recoveryConverted,
        conversionRatePct: recoverySent > 0 ? Number(((recoveryConverted / recoverySent) * 100).toFixed(2)) : 0,
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

app.post("/api/admin/plan/assign", requireAdmin, RATE_LIMITERS.adminWrite, async function assignPlanTier(req, res) {
  const requestedTier = normalizePlanTier(req.body && req.body.planTier);
  if (!requestedTier) {
    res.status(400).json({ error: "planTier inválido. Usa free, one, pack o sub." });
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
        throw createError("No se encontró usuario objetivo para asignar plan.", 404);
      }

      await client.query(
        "UPDATE user_credits SET plan_tier = $2, subscription_active = CASE WHEN $2 = 'sub' THEN true ELSE false END, updated_at = NOW() WHERE user_id = $1",
        [target.id, requestedTier]
      );
      await recordEvent(client, "admin_plan_assigned", target.id, target.customer_id, {
        planTier: requestedTier,
      });
      return getUserById(client, target.id);
    });

    res.json({
      ok: true,
      planTier: requestedTier,
      user: publicUser(user),
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    res.status(status).json({ error: String(error && error.message || "No se pudo asignar plan.") });
  }
});

app.post("/api/admin/marketing/spend", requireAdmin, RATE_LIMITERS.adminWrite, async function registerMarketingSpend(req, res) {
  const rawAmount = Number(req.body && req.body.amountCents);
  const amountCents = Number.isFinite(rawAmount) ? Math.floor(rawAmount) : 0;
  const channel = normalizeMarketingChannel(req.body && req.body.channel);
  const note = String(req.body && req.body.note || "").trim().slice(0, 240);
  const spentAtRaw = String(req.body && req.body.spentAt || "").trim();
  const spentAtDate = spentAtRaw ? new Date(spentAtRaw) : new Date();
  if (amountCents <= 0 || amountCents > 100000000) {
    res.status(400).json({ error: "amountCents debe estar entre 1 y 100000000." });
    return;
  }
  if (!channel) {
    res.status(400).json({ error: "channel es obligatorio (ej: ads, seo, afiliados)." });
    return;
  }
  if (Number.isNaN(spentAtDate.getTime())) {
    res.status(400).json({ error: "spentAt inválido." });
    return;
  }

  try {
    const created = await withTransaction(async function tx(client) {
      const inserted = await client.query(
        "INSERT INTO marketing_costs (channel, amount_cents, spent_at, note, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id, channel, amount_cents, spent_at, note, created_at",
        [channel, amountCents, spentAtDate.toISOString(), note || null]
      );
      await recordEvent(client, "admin_marketing_spend_recorded", null, null, {
        channel: channel,
        amountCents: amountCents,
      });
      return inserted.rows[0];
    });

    res.json({
      ok: true,
      spend: created,
    });
  } catch (error) {
    res.status(500).json({ error: "No se pudo registrar gasto de marketing.", detail: String(error && error.message || error) });
  }
});

app.post("/api/admin/recovery/checkout/run", requireAdmin, RATE_LIMITERS.adminWrite, async function runCheckoutRecovery(req, res) {
  const limit = Math.max(1, Math.min(100, toPositiveInt(req.body && req.body.limit, CONFIG.recoveryBatchSize)));
  const dryRun = Boolean(req.body && req.body.dryRun);
  try {
    const result = await runCheckoutRecoverySweep({
      trigger: "admin",
      limit: limit,
      dryRun: dryRun,
      force: true,
    });
    res.json(Object.assign({ ok: true }, result));
  } catch (error) {
    res.status(500).json({ error: "No se pudo ejecutar recuperación de checkout.", detail: String(error && error.message || error) });
  }
});

app.get("/api/admin/recovery/checkout/stats", requireAdmin, RATE_LIMITERS.adminRead, async function checkoutRecoveryStats(req, res) {
  const days = Math.max(1, Math.min(365, toPositiveInt(req.query && req.query.days, 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const stats = await withTransaction(async function tx(client) {
      const candidates = await client.query(
        "SELECT COUNT(*)::int AS total FROM payment_sessions WHERE status IN ('created','pending') AND created_at <= $1",
        [new Date(Date.now() - CONFIG.recoveryDelayMinutes * 60 * 1000).toISOString()]
      );
      const sent = await client.query(
        "SELECT COUNT(*)::int AS total FROM payment_sessions WHERE recovery_email_sent_at IS NOT NULL AND recovery_email_sent_at >= $1",
        [since.toISOString()]
      );
      const converted = await client.query(
        "SELECT COUNT(*)::int AS total FROM payment_sessions WHERE status = 'completed' AND recovery_email_sent_at IS NOT NULL AND updated_at >= $1",
        [since.toISOString()]
      );
      return {
        candidates: Number(candidates.rows[0].total || 0),
        sent: Number(sent.rows[0].total || 0),
        converted: Number(converted.rows[0].total || 0),
      };
    });

    res.json({
      ok: true,
      windowDays: days,
      recovery: {
        candidates: stats.candidates,
        sent: stats.sent,
        converted: stats.converted,
        conversionRatePct: stats.sent > 0 ? Number(((stats.converted / stats.sent) * 100).toFixed(2)) : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "No se pudieron cargar estadísticas de recuperación.", detail: String(error && error.message || error) });
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
let recoverySweepTimer = null;
let recoverySweepRunning = false;

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

  startCheckoutRecoveryTimer();

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
  stopCheckoutRecoveryTimer();

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

async function deliverEmail(to, subject, text) {
  if (!mailer) {
    console.info("[dev-email] to=%s subject=%s", to, subject);
    return "dev-log";
  }
  await mailer.sendMail({
    from: CONFIG.smtpFrom,
    to: to,
    subject: subject,
    text: text,
  });
  return "smtp";
}

function buildCheckoutRecoveryURL(sessionId, stripeSession) {
  if (stripeSession && stripeSession.url) {
    return String(stripeSession.url);
  }
  return CONFIG.appBaseURL + "/?checkout=resume&session_id=" + encodeURIComponent(sessionId);
}

async function sendCheckoutRecoveryEmail(candidate, checkoutURL) {
  const email = String(candidate && candidate.email || "").trim().toLowerCase();
  if (!email) {
    throw createError("No hay email para recuperación.", 400);
  }
  const subject = "Tu compra en Simplify sigue pendiente";
  const text = [
    "Hola" + (candidate && candidate.name ? " " + String(candidate.name).trim() : "") + ",",
    "",
    "Vimos que dejaste una compra de créditos/suscripción sin completar.",
    "Puedes retomarla desde este enlace seguro:",
    checkoutURL,
    "",
    "Si ya completaste el pago, ignora este correo.",
    "",
    "Equipo Simplify",
  ].join("\n");
  return deliverEmail(email, subject, text);
}

function startCheckoutRecoveryTimer() {
  if (recoverySweepTimer || !serverInstance) {
    return;
  }
  const intervalMs = CONFIG.recoverySweepMinutes * 60 * 1000;
  recoverySweepTimer = setInterval(function onRecoveryTick() {
    runCheckoutRecoverySweep({
      trigger: "interval",
      limit: CONFIG.recoveryBatchSize,
      force: false,
      dryRun: false,
    }).catch(function onError(error) {
      logError("checkout.recovery.sweep.error", {
        message: String(error && error.message || error),
      });
    });
  }, intervalMs);
  if (typeof recoverySweepTimer.unref === "function") {
    recoverySweepTimer.unref();
  }
}

function stopCheckoutRecoveryTimer() {
  if (!recoverySweepTimer) {
    return;
  }
  clearInterval(recoverySweepTimer);
  recoverySweepTimer = null;
}

async function runCheckoutRecoverySweep(options) {
  const opts = Object.assign({
    trigger: "manual",
    limit: CONFIG.recoveryBatchSize,
    force: false,
    dryRun: false,
  }, options || {});

  if (recoverySweepRunning) {
    return {
      trigger: opts.trigger,
      skipped: true,
      reason: "already-running",
      candidates: 0,
      emailed: 0,
      reconciled: 0,
      failed: 0,
      dryRun: Boolean(opts.dryRun),
    };
  }

  recoverySweepRunning = true;
  const now = new Date();
  const nowIso = now.toISOString();
  const candidateBeforeIso = new Date(now.getTime() - CONFIG.recoveryDelayMinutes * 60 * 1000).toISOString();
  const nextAttemptIso = new Date(now.getTime() + CONFIG.recoveryDelayMinutes * 60 * 1000).toISOString();

  try {
    const candidates = await withTransaction(async function tx(client) {
      const rows = await client.query(
        [
          "SELECT",
          "ps.session_id, ps.user_id, ps.customer_id, ps.plan_id, ps.created_at,",
          "COALESCE(ps.recovery_attempts, 0)::int AS recovery_attempts,",
          "ps.recovery_email_sent_at, ps.recovery_next_attempt_at,",
          "u.email, u.name",
          "FROM payment_sessions ps",
          "LEFT JOIN app_users u ON u.id = ps.user_id",
          "WHERE ps.status IN ('created','pending')",
          "AND COALESCE(ps.recovery_attempts, 0) < $1",
          "AND ps.created_at <= $2",
          "AND (ps.recovery_next_attempt_at IS NULL OR ps.recovery_next_attempt_at <= $3)",
          "ORDER BY ps.created_at ASC",
          "LIMIT $4",
        ].join(" "),
        [CONFIG.recoveryMaxAttempts, candidateBeforeIso, nowIso, Math.max(1, Math.min(100, Number(opts.limit) || CONFIG.recoveryBatchSize))]
      );
      return rows.rows;
    });

    let reconciled = 0;
    let emailed = 0;
    let failed = 0;
    let skippedNoEmail = 0;

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      let stripeSession = null;
      let checkoutURL = buildCheckoutRecoveryURL(candidate.session_id, null);

      if (stripe) {
        try {
          stripeSession = await stripe.checkout.sessions.retrieve(candidate.session_id);
          if (stripeSession && (stripeSession.payment_status === "paid" || stripeSession.status === "complete")) {
            await withTransaction(async function tx(client) {
              await processCheckoutCompleted(client, stripeSession);
            });
            reconciled += 1;
            continue;
          }
          checkoutURL = buildCheckoutRecoveryURL(candidate.session_id, stripeSession);
        } catch (_stripeError) {
          // Fallback to app URL if Stripe cannot be read.
          checkoutURL = buildCheckoutRecoveryURL(candidate.session_id, null);
        }
      }

      if (!candidate.email) {
        skippedNoEmail += 1;
        await withTransaction(async function tx(client) {
          await client.query(
            "UPDATE payment_sessions SET recovery_attempts = COALESCE(recovery_attempts,0) + 1, recovery_last_error = $2, recovery_next_attempt_at = $3, updated_at = NOW() WHERE session_id = $1",
            [candidate.session_id, "email-missing", nextAttemptIso]
          );
          await recordEvent(client, "checkout_recovery_skipped", candidate.user_id || null, candidate.customer_id || null, {
            sessionId: candidate.session_id,
            reason: "email-missing",
            trigger: opts.trigger,
          });
        });
        continue;
      }

      if (opts.dryRun) {
        continue;
      }

      try {
        const delivery = await sendCheckoutRecoveryEmail(candidate, checkoutURL);
        emailed += 1;
        await withTransaction(async function tx(client) {
          await client.query(
            "UPDATE payment_sessions SET status = 'pending', recovery_email_sent_at = NOW(), recovery_attempts = COALESCE(recovery_attempts,0) + 1, recovery_last_error = NULL, recovery_next_attempt_at = $2, updated_at = NOW() WHERE session_id = $1",
            [candidate.session_id, nextAttemptIso]
          );
          await recordEvent(client, "checkout_recovery_email_sent", candidate.user_id || null, candidate.customer_id || null, {
            sessionId: candidate.session_id,
            planId: candidate.plan_id || "",
            delivery: delivery,
            trigger: opts.trigger,
          });
        });
      } catch (error) {
        failed += 1;
        await withTransaction(async function tx(client) {
          await client.query(
            "UPDATE payment_sessions SET recovery_attempts = COALESCE(recovery_attempts,0) + 1, recovery_last_error = $2, recovery_next_attempt_at = $3, updated_at = NOW() WHERE session_id = $1",
            [candidate.session_id, String(error && error.message || error).slice(0, 180), nextAttemptIso]
          );
          await recordEvent(client, "checkout_recovery_email_failed", candidate.user_id || null, candidate.customer_id || null, {
            sessionId: candidate.session_id,
            reason: String(error && error.message || error).slice(0, 180),
            trigger: opts.trigger,
          });
        });
      }
    }

    return {
      trigger: opts.trigger,
      skipped: false,
      dryRun: Boolean(opts.dryRun),
      candidates: candidates.length,
      emailed: emailed,
      reconciled: reconciled,
      failed: failed,
      skippedNoEmail: skippedNoEmail,
    };
  } finally {
    recoverySweepRunning = false;
  }
}

function publicPlans() {
  return Object.keys(PLAN_CONFIG).reduce(function reducePlans(acc, key) {
    const plan = PLAN_CONFIG[key];
    const planTier = mapPlanIdToTier(plan.id);
    acc[key] = {
      id: plan.id,
      label: plan.label,
      mode: plan.mode,
      tier: planTier,
      credits: plan.credits,
      limits: getPlanLimitsForTier(planTier),
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
    "CREATE TABLE IF NOT EXISTS user_credits (user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE, credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0), free_used INTEGER NOT NULL DEFAULT 0 CHECK (free_used >= 0), free_uses INTEGER NOT NULL DEFAULT 3 CHECK (free_uses >= 0), total_purchased INTEGER NOT NULL DEFAULT 0 CHECK (total_purchased >= 0), total_consumed INTEGER NOT NULL DEFAULT 0 CHECK (total_consumed >= 0), subscription_active BOOLEAN NOT NULL DEFAULT FALSE, subscription_credits_cycle INTEGER NOT NULL DEFAULT 250 CHECK (subscription_credits_cycle >= 0), plan_tier TEXT NOT NULL DEFAULT 'free', stripe_customer_id TEXT UNIQUE, stripe_subscription_id TEXT UNIQUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS payment_sessions (session_id TEXT PRIMARY KEY, user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL, customer_id TEXT NOT NULL, plan_id TEXT NOT NULL, status TEXT NOT NULL, amount_total INTEGER, currency TEXT NOT NULL, credits_granted INTEGER NOT NULL DEFAULT 0, granted BOOLEAN NOT NULL DEFAULT FALSE, stripe_customer_id TEXT, stripe_subscription_id TEXT, recovery_attempts INTEGER NOT NULL DEFAULT 0, recovery_email_sent_at TIMESTAMPTZ, recovery_next_attempt_at TIMESTAMPTZ, recovery_last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_user ON payment_sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_status ON payment_sessions(status)",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_recovery_next_attempt ON payment_sessions(recovery_next_attempt_at)",
    "CREATE TABLE IF NOT EXISTS processed_invoices (invoice_id TEXT PRIMARY KEY, user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, payload JSONB NOT NULL, processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS email_login_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS app_events (id BIGSERIAL PRIMARY KEY, event_name TEXT NOT NULL, user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL, customer_id TEXT, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_app_events_created_at ON app_events(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_app_events_event_name ON app_events(event_name)",
    "CREATE TABLE IF NOT EXISTS legal_consents (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, customer_id TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'web', accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), user_agent TEXT, ip_hash TEXT)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_consents_user_version ON legal_consents(user_id, version)",
    "CREATE INDEX IF NOT EXISTS idx_legal_consents_customer_version ON legal_consents(customer_id, version)",
    "CREATE TABLE IF NOT EXISTS marketing_costs (id BIGSERIAL PRIMARY KEY, channel TEXT NOT NULL, amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0), spent_at TIMESTAMPTZ NOT NULL, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_marketing_costs_spent_at ON marketing_costs(spent_at)",
    "ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'free'",
    "ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ",
    "ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS recovery_next_attempt_at TIMESTAMPTZ",
    "ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS recovery_last_error TEXT",
  ];

  for (let i = 0; i < ddl.length; i += 1) {
    try {
      await pool.query(ddl[i]);
    } catch (error) {
      if (isIgnorableMigrationError(error, ddl[i])) {
        continue;
      }
      throw error;
    }
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
  "c.subscription_credits_cycle, c.plan_tier, c.stripe_customer_id, c.stripe_subscription_id, c.updated_at AS credits_updated_at",
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
    "INSERT INTO user_credits (user_id, credits, free_used, free_uses, total_purchased, total_consumed, subscription_active, subscription_credits_cycle, plan_tier, updated_at) VALUES ($1,0,0,$2,0,0,false,$3,'free',NOW())",
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
  const mergedTier = chooseHigherPlanTier(target.plan_tier, source.plan_tier, Boolean(target.subscription_active || source.subscription_active));
  await client.query(
    "UPDATE user_credits SET plan_tier = $2, updated_at = NOW() WHERE user_id = $1",
    [targetUserId, mergedTier]
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
  const purchasedTier = normalizePlanTier(mapPlanIdToTier(metadataPlan)) || "free";
  const finalTier = chooseHigherPlanTier(user.plan_tier, purchasedTier, Boolean(user.subscription_active || session.subscription));

  await client.query(
    "INSERT INTO payment_sessions (session_id, user_id, customer_id, plan_id, status, amount_total, currency, credits_granted, granted, stripe_customer_id, stripe_subscription_id, recovery_last_error, recovery_next_attempt_at, created_at, updated_at) VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,$8,$9,$10,NULL,NULL,NOW(),NOW()) ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id, customer_id = EXCLUDED.customer_id, plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, amount_total = EXCLUDED.amount_total, currency = EXCLUDED.currency, credits_granted = EXCLUDED.credits_granted, granted = EXCLUDED.granted, stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = EXCLUDED.stripe_subscription_id, recovery_last_error = NULL, recovery_next_attempt_at = NULL, updated_at = NOW()",
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
      "UPDATE user_credits SET stripe_customer_id = COALESCE($2, stripe_customer_id), stripe_subscription_id = COALESCE($3, stripe_subscription_id), subscription_active = CASE WHEN $3 IS NULL THEN subscription_active ELSE true END, subscription_credits_cycle = CASE WHEN $4 > 0 THEN $4 ELSE subscription_credits_cycle END, plan_tier = $5, updated_at = NOW() WHERE user_id = $1",
      [user.id, session.customer || null, session.subscription || null, creditsGranted, finalTier]
    );
  } else {
    await client.query(
      "UPDATE user_credits SET plan_tier = $2, updated_at = NOW() WHERE user_id = $1",
      [user.id, finalTier]
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
    planTier: finalTier,
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
    "UPDATE user_credits SET subscription_active = true, plan_tier = 'sub', updated_at = NOW() WHERE user_id = $1",
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
    "UPDATE user_credits SET subscription_active = $2, plan_tier = CASE WHEN $2 THEN 'sub' ELSE CASE WHEN plan_tier = 'sub' THEN 'free' ELSE plan_tier END END, updated_at = NOW() WHERE user_id = $1",
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
    "UPDATE user_credits SET subscription_active = false, plan_tier = CASE WHEN plan_tier = 'sub' THEN 'free' ELSE plan_tier END, updated_at = NOW() WHERE user_id = $1",
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
  const planTier = getEffectivePlanTier(user);
  const limits = getPlanLimitsForTier(planTier);
  return {
    credits: Math.max(0, Number(user.credits || 0)),
    freeUses: freeUses,
    freeUsed: freeUsed,
    freeLeft: freeLeft,
    planTier: planTier,
    limits: limits,
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

function normalizePlanTier(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "free" || normalized === "one" || normalized === "pack" || normalized === "sub") {
    return normalized;
  }
  return "";
}

function mapPlanIdToTier(planId) {
  const normalized = String(planId || "").trim().toLowerCase();
  if (normalized === "one" || normalized === "pack" || normalized === "sub") {
    return normalized;
  }
  return "free";
}

function chooseHigherPlanTier(currentTier, incomingTier, forceSubscription) {
  if (forceSubscription) {
    return "sub";
  }
  const current = normalizePlanTier(currentTier) || "free";
  const incoming = normalizePlanTier(incomingTier) || "free";
  const currentOrder = Number(PLAN_TIER_ORDER[current] || 0);
  const incomingOrder = Number(PLAN_TIER_ORDER[incoming] || 0);
  return incomingOrder > currentOrder ? incoming : current;
}

function getEffectivePlanTier(user) {
  if (user && Boolean(user.subscription_active)) {
    return "sub";
  }
  return normalizePlanTier(user && user.plan_tier) || "free";
}

function getPlanLimitsForTier(planTier) {
  const normalized = normalizePlanTier(planTier) || "free";
  return PLAN_LIMITS[normalized] || PLAN_LIMITS.free;
}

function normalizeMarketingChannel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 40);
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

function isIgnorableMigrationError(error, statement) {
  const sql = String(statement || "").trim().toLowerCase();
  const message = String(error && error.message || "").toLowerCase();
  if (!sql.startsWith("alter table")) {
    return false;
  }
  if (message.includes("already exists") || message.includes("duplicate column")) {
    return true;
  }
  if (message.includes("syntax") && message.includes("if not exists")) {
    return true;
  }
  return false;
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
