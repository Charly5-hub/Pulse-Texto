import { expect, test } from "@playwright/test";

const API_HOSTS = ["http://localhost:8787", "http://127.0.0.1:8787"];

function createMockState() {
  return {
    customerId: "cust_ui_mock_001",
    token: "mock.jwt.token",
    authenticated: false,
    freeUses: 3,
    freeUsed: 0,
    credits: 0,
    adminUser: {
      id: "user-admin-ui",
      customerId: "cust_ui_admin",
      email: "admin@simplify.local",
      role: "admin",
      provider: "email",
      balance: {
        credits: 500,
        freeUses: 3,
        freeUsed: 0,
        freeLeft: 3,
        totalPurchased: 500,
        totalConsumed: 0,
        subscriptionActive: true,
      },
    },
  };
}

function buildBalance(state) {
  return {
    credits: state.credits,
    freeUses: state.freeUses,
    freeUsed: state.freeUsed,
    freeLeft: Math.max(0, state.freeUses - state.freeUsed),
    totalPurchased: state.credits,
    totalConsumed: 0,
    subscriptionActive: false,
  };
}

async function installApiMocks(page, options = {}) {
  const state = createMockState();
  if (typeof options.initialCredits === "number") {
    state.credits = options.initialCredits;
  }
  if (options.authenticated) {
    state.authenticated = true;
  }

  async function fulfillJSON(route, status, body) {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  }

  async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let payload = {};
    try {
      const raw = request.postData();
      payload = raw ? JSON.parse(raw) : {};
    } catch (_error) {
      payload = {};
    }

    if (path === "/api/auth/session/anonymous") {
      state.customerId = payload.customerId || state.customerId;
      await fulfillJSON(route, 200, {
        ok: true,
        token: state.token,
        user: {
          id: "user-anon-ui",
          customerId: state.customerId,
          role: "user",
          provider: "anonymous",
          balance: buildBalance(state),
        },
      });
      return;
    }

    if (path === "/api/auth/me") {
      if (state.authenticated) {
        await fulfillJSON(route, 200, {
          ok: true,
          user: {
            id: "user-auth-ui",
            customerId: state.customerId,
            email: "qa@simplify.local",
            role: "user",
            provider: "email",
            balance: buildBalance(state),
          },
        });
        return;
      }
      await fulfillJSON(route, 401, { error: "Autenticación requerida." });
      return;
    }

    if (path === "/api/auth/email/request-code") {
      await fulfillJSON(route, 200, {
        ok: true,
        delivery: "dev-log",
        customerId: state.customerId,
        devCode: "123456",
        expiresInMinutes: 10,
      });
      return;
    }

    if (path === "/api/auth/email/verify-code") {
      state.authenticated = true;
      await fulfillJSON(route, 200, {
        ok: true,
        token: state.token,
        user: {
          id: "user-auth-ui",
          customerId: state.customerId,
          email: "qa@simplify.local",
          role: "user",
          provider: "email",
          balance: buildBalance(state),
        },
      });
      return;
    }

    if (path === "/api/auth/google") {
      state.authenticated = true;
      await fulfillJSON(route, 200, {
        ok: true,
        token: state.token,
        user: {
          id: "user-auth-google",
          customerId: state.customerId,
          email: "google@simplify.local",
          role: "user",
          provider: "google",
          balance: buildBalance(state),
        },
      });
      return;
    }

    if (path === "/api/pay/plans") {
      await fulfillJSON(route, 200, {
        stripeConfigured: true,
        currency: "eur",
        plans: {
          one: { id: "one", credits: 1, amountCents: 100, currency: "eur" },
          pack: { id: "pack", credits: 10, amountCents: 500, currency: "eur" },
          sub: { id: "sub", credits: 250, amountCents: 800, currency: "eur" },
        },
      });
      return;
    }

    if (path === "/api/pay/balance") {
      await fulfillJSON(route, 200, {
        ok: true,
        customerId: state.customerId,
        balance: buildBalance(state),
      });
      return;
    }

    if (path === "/api/pay/consume") {
      var units = Number(payload.units || 1);
      state.credits = Math.max(0, state.credits - units);
      await fulfillJSON(route, 200, {
        ok: true,
        customerId: state.customerId,
        consumed: units,
        balance: buildBalance(state),
      });
      return;
    }

    if (path === "/api/pay/checkout") {
      const checkoutUrl = "http://127.0.0.1:4173/?checkout=success";
      await fulfillJSON(route, 200, {
        ok: true,
        sessionId: "cs_test_ui_001",
        checkoutUrl,
        customerId: state.customerId,
      });
      return;
    }

    if (path === "/api/events/track") {
      await fulfillJSON(route, 202, { ok: true });
      return;
    }

    if (path === "/api/ai/generate") {
      if (state.freeUsed < state.freeUses) {
        state.freeUsed += 1;
      } else if (state.credits > 0) {
        state.credits -= 1;
      } else {
        await fulfillJSON(route, 402, { error: "Créditos insuficientes." });
        return;
      }
      await fulfillJSON(route, 200, {
        output: "Salida IA mock para validación de Playwright.",
        model: "mock-gpt-ui",
        billing: {
          source: state.freeUsed <= state.freeUses ? "free" : "credit",
        },
        balance: buildBalance(state),
      });
      return;
    }

    if (path === "/api/admin/metrics") {
      await fulfillJSON(route, 200, {
        ok: true,
        kpis: {
          totalUsers: 42,
          authenticatedUsers: 21,
          payingUsers: 8,
          activeSubscriptions: 3,
          completedPayments: 12,
          totalCreditsRemaining: 4200,
          revenueCents: 128000,
        },
        funnel: {
          generationCompleted: 120,
          resultCopied: 55,
          checkoutStarted: 12,
          checkoutSuccessReturn: 8,
          checkoutReturnRatePct: 66.67,
          copyRatePct: 45.83,
        },
        events: [{ event_name: "generation_completed", total: 120 }],
        topActions: [{ action: "summary", total: 68 }],
        dailyEvents: [{ day: "2026-02-20", event_name: "generation_completed", total: 15 }],
        dailyRevenue: [{ day: "2026-02-20", revenue_cents: 5000, payments: 1 }],
      });
      return;
    }

    if (path === "/api/admin/reconcile/payments") {
      await fulfillJSON(route, 200, {
        ok: true,
        requested: 3,
        reconciled: 2,
        pending: 1,
        failed: 0,
      });
      return;
    }

    if (path === "/api/admin/credits/grant") {
      var granted = Number(payload.credits || 0);
      state.credits += granted;
      await fulfillJSON(route, 200, {
        ok: true,
        granted,
        user: state.adminUser,
      });
      return;
    }

    await fulfillJSON(route, 404, { error: "Unhandled mock path: " + path });
  }

  for (const host of API_HOSTS) {
    await page.route(host + "/**", handleRoute);
  }

  return state;
}

test("local generation renders output and history", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/");
  await page.selectOption("#engine-mode", "local");
  await page.fill("#input", "Texto de prueba para validar el flujo local de transformación.");
  await page.click("#btn-suggest");
  await page.waitForTimeout(350);

  const resultText = await page.locator("#tab-res").textContent();
  expect(resultText && resultText.trim().length).toBeGreaterThan(0);
  await expect(page.locator("#status-line")).toContainText("Motor:");
  await expect(page.locator("#history-list .history-item")).toHaveCount(1);
});

test("email OTP login flow updates session state", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/");

  await page.fill("#auth-email", "qa@simplify.local");
  await page.click("#btn-auth-request");
  await expect(page.locator("#auth-status")).toContainText("DEV OTP: 123456");

  await page.fill("#auth-code", "123456");
  await page.click("#btn-auth-verify");
  await expect(page.locator("#auth-status")).toContainText("Sesión iniciada correctamente.");
  await expect(page.locator("#btn-auth-logout")).toBeVisible();
});

test("admin tools and checkout flow work with mocked APIs", async ({ page }) => {
  await installApiMocks(page, { initialCredits: 5 });
  await page.goto("/?admin=1");

  await expect(page.locator("#admin-panel")).toBeVisible();
  await page.fill("#admin-api-key", "test-admin-key");

  await page.click("#btn-admin-metrics");
  await expect(page.locator("#admin-output")).toContainText("totalUsers");

  await page.fill("#admin-target-customer", "cust_ui_mock_001");
  await page.fill("#admin-grant-credits", "10");
  await page.click("#btn-admin-grant");
  await expect(page.locator("#admin-output")).toContainText("\"granted\": 10");

  await page.click("#pay-one");
  await page.waitForURL("**/?checkout=success");
  await page.waitForTimeout(350);
  await expect(page.locator("#pay-status")).toContainText("Créditos actualizados");
});
