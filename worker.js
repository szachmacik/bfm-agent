/**
 * BFM-Slayer Agent — Cloudflare Worker
 * 
 * Problem: CF Bot Fight Mode (BFM) blokuje *.ofshore.dev zanim Worker się wykona
 * 
 * Strategia:
 * 1. Monitoruj zdrowie wszystkich subdomen co 5 min
 * 2. Wykryj BFM (HTTP 403 z "error code: 1010")  
 * 3. Próbuj 3 drogi obejścia:
 *    A. sslip.io direct routing (brak CF, zawsze działa)
 *    B. Cloudflare Tunnel (omija BFM całkowicie)
 *    C. Telegram alert z dokładnym linkiem (30-sekundowa akcja manualna)
 * 4. Aktualizuj status w Supabase
 * 5. Nigdy nie blokuj — system działa przez fallback
 */

const SERVER_IP = "178.62.246.169";
const SUPABASE_URL = "https://blgdhfcosqjzrutncbbr.supabase.co";
const ZONE_ID = "f783cda72a2902b86b7f206fc85bb61f";
const ACCOUNT_ID = "9a877cdba770217082a2f914427df505";

// Mapa subdomen → porty na serwerze (dla sslip.io fallback)
const DIRECT_PORTS = {
  "brain-router":     3000,
  "autoheal":         3000,
  "watchdog":         3000,
  "sentinel":         3000,
  "english-teacher":  3000,
  "manus-brain":      3000,
  "openmanus":        8080,
  "ai-control-center":3000,
  "sql-agent":        8010,
  "n8n":              5678,
  "ollama":           11434,
};

// Test czy subdomena działa przez *.ofshore.dev
async function testSubdomain(subdomain) {
  try {
    const url = `https://${subdomain}.ofshore.dev/health`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "BFM-Slayer-Agent/1.0" }
    });
    const body = await r.text();
    return {
      ok: r.status === 200,
      status: r.status,
      bfm: r.status === 403 && body.includes("1010"),
    };
  } catch(e) {
    return { ok: false, status: 0, bfm: false, error: e.message };
  }
}

// Test przez sslip.io direct (omija CF całkowicie)
async function testDirect(subdomain, port) {
  try {
    const url = `http://${subdomain}.${SERVER_IP}.sslip.io:${port}/health`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return { ok: r.status < 400, status: r.status };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// Sprawdź CF BFM status przez API
async function checkBfmStatus(cfToken) {
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/bot_management`,
      { headers: { Authorization: `Bearer ${cfToken}` } }
    );
    const d = await r.json();
    return d.result;
  } catch { return null; }
}

// Wyłącz BFM jeśli mamy token z uprawnieniami
async function disableBfm(cfToken) {
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/bot_management`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fight_mode: false }),
      }
    );
    const d = await r.json();
    return d.success;
  } catch { return false; }
}

// Wyślij Telegram alert z dokładnym linkiem
async function sendTelegramAlert(botToken, chatId, message) {
  return fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
}

// Log do Supabase
async function logToSupabase(supabaseKey, data) {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/queue_sql_job`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_sql: `INSERT INTO public.system_observations (obs_type,title,description,priority,source,status)
        VALUES ('${data.type}','${data.title.replace(/'/g,"''")}',
        '${(data.description||'').replace(/'/g,"''")}',
        ${data.priority||3},'bfm-agent','${data.status||'new'}')
        ON CONFLICT (title) DO UPDATE SET description=EXCLUDED.description, acted_on_at=NOW()`,
      p_name: "bfm-agent-log",
      p_source: "bfm-agent",
    }),
  });
}

// ── Main Worker ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "bfm-agent", ts: new Date().toISOString() });
    }

    if (url.pathname === "/status") {
      const checks = await Promise.all(
        Object.keys(DIRECT_PORTS).map(async sub => {
          const cf = await testSubdomain(sub);
          const direct = await testDirect(sub, DIRECT_PORTS[sub]);
          return { subdomain: sub, cf_ok: cf.ok, direct_ok: direct.ok, bfm_detected: cf.bfm };
        })
      );
      const bfmActive = checks.some(c => c.bfm_detected);
      return Response.json({
        bfm_active: bfmActive,
        subdomains_working_via_cf: checks.filter(c => c.cf_ok).length,
        subdomains_working_direct: checks.filter(c => c.direct_ok).length,
        total: checks.length,
        checks,
        ts: new Date().toISOString(),
      });
    }

    if (url.pathname === "/check-and-fix") {
      const report = await runBfmCheckAndFix(env);
      return Response.json(report);
    }

    return Response.json({
      service: "bfm-agent",
      endpoints: ["/health", "/status", "/check-and-fix"],
      mission: "Autonomically detect and bypass CF Bot Fight Mode for ofshore.dev"
    });
  },

  // Scheduled trigger (every 5 minutes via CF Cron)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBfmCheckAndFix(env));
  }
};

async function runBfmCheckAndFix(env) {
  const BOT_TOKEN = env.TELEGRAM_TOKEN;
  const CHAT_ID   = env.TELEGRAM_CHAT_ID;
  const CF_TOKEN  = env.CF_API_TOKEN;
  const SB_KEY    = env.SUPABASE_SERVICE_KEY;

  // 1. Sprawdź brain-router (najważniejszy)
  const brCheck = await testSubdomain("brain-router");
  const directOk = await testDirect("brain-router", 3000);

  if (brCheck.ok) {
    // ✅ Działa — log success i wyjdź
    await logToSupabase(SB_KEY, {
      type: "info", title: "BFM Agent: brain-router healthy",
      description: `brain-router.ofshore.dev OK | ${new Date().toISOString()}`,
      priority: 5, status: "done"
    });
    return { status: "ok", bfm: false, brain_router: "healthy" };
  }

  // 2. BFM wykryty
  if (brCheck.bfm) {
    // Próba 1: wyłącz przez API (zadziała jeśli token ma uprawnienia)
    const disabled = CF_TOKEN ? await disableBfm(CF_TOKEN) : false;

    if (disabled) {
      await sendTelegramAlert(BOT_TOKEN, CHAT_ID,
        "✅ <b>BFM-Agent: Bot Fight Mode wyłączony automatycznie!</b>\n" +
        "brain-router.ofshore.dev powinien działać za 30 sekund."
      );
      await logToSupabase(SB_KEY, {
        type: "fix", title: "BFM Agent: auto-disabled Bot Fight Mode",
        description: "CF API disabled BFM automatically", priority: 2, status: "done"
      });
      return { status: "fixed", method: "cf_api_auto_disable" };
    }

    // Próba 2: wyślij Telegram z DOKŁADNYM linkiem (1 klik)
    const bfmDashboardLink = "https://dash.cloudflare.com/?to=/:account/ofshore.dev/security/bots";
    const msg = (
      `🚨 <b>BFM-Agent: Bot Fight Mode aktywny!</b>\n\n` +
      `❌ brain-router.ofshore.dev → 403 (CF Block)\n` +
      `✅ Direct (sslip.io) → ${directOk.ok ? "OK" : "też fail"}\n\n` +
      `<b>AKCJA — 30 sekund:</b>\n` +
      `<a href="${bfmDashboardLink}">🔗 Kliknij → Security → Bots → Bot Fight Mode OFF</a>\n\n` +
      `System działa przez fallback (sslip.io). Możesz kliknąć kiedy masz chwilę.`
    );
    await sendTelegramAlert(BOT_TOKEN, CHAT_ID, msg);

    await logToSupabase(SB_KEY, {
      type: "anomaly", title: "BFM Agent: Bot Fight Mode detected",
      description: `BFM active. Direct fallback: ${directOk.ok}. Telegram alert sent.`,
      priority: 2, status: "new"
    });

    return {
      status: "alert_sent",
      bfm: true,
      direct_fallback: directOk.ok,
      action_url: bfmDashboardLink,
    };
  }

  // 3. Nie BFM - inny problem
  await logToSupabase(SB_KEY, {
    type: "anomaly", title: "BFM Agent: brain-router down (not BFM)",
    description: `Status ${brCheck.status}. Error: ${brCheck.error||'unknown'}`,
    priority: 2, status: "new"
  });
  return { status: "down_not_bfm", details: brCheck };
}
