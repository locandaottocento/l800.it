// functions/_stripe-lib.js
// Helper condivisi tra le Cloudflare Pages Functions Stripe.
// Nota: questo file NON esporta onRequest* quindi non diventa una route —
// è un modulo di libreria importato da stripe-create-intent.js, stripe-finalize.js
// e stripe-webhook.js.
// Runtime: Cloudflare Workers — niente SDK Node "stripe", solo fetch() verso l'API REST
// e Web Crypto per la verifica delle firme webhook.

export const STRIPE_API = 'https://api.stripe.com/v1';

// Stesso listino di functions/send-voucher.js — tenuto in sync manualmente
// (nessun modulo condiviso preesistente nel progetto per questo).
export const PREZZI_VOUCHER = { 3: 50, 4: 65 };
export const IMPORTO_LIBERO_MIN = 25;
export const IMPORTO_LIBERO_MAX_TECNICO = 5000;

export function calcolaImportoAtteso(numPortate, numPersone) {
  const prezzoUnit = PREZZI_VOUCHER[numPortate];
  if (!prezzoUnit) return null;
  const persone = parseInt(numPersone, 10);
  if (!Number.isFinite(persone) || persone < 1 || persone > 200) return null;
  return prezzoUnit * persone;
}

export function jsonResponse(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export function buildCors(origin) {
  const allowed = ['https://www.l800.it', 'https://l800.it'];
  const allowOrigin = allowed.includes(origin) ? origin : 'https://www.l800.it';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Timeout dopo ${timeoutMs}ms: ${url}`);
    throw err;
  }
}

// Stesso formato codice di functions/send-voucher.js (charset senza O/0/I/1)
export function generaCodice(tipo, numPortate) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  let rand = '';
  for (let i = 0; i < 4; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  const prefix = tipo === 'libero' ? 'LIB' : `${numPortate}P`;
  return `L800-${prefix}-${rand}${ts}`;
}

// ── Chiamate REST a Stripe (form-urlencoded, come richiesto dall'API) ──
function toFormParams(obj, params = new URLSearchParams(), prefix = '') {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      toFormParams(value, params, paramKey);
    } else {
      params.append(paramKey, String(value));
    }
  }
  return params;
}

export async function stripeRequest(env, method, path, body) {
  const headers = {
    'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
  };
  let requestBody;
  if (body && method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    requestBody = toFormParams(body).toString();
  }
  const res = await fetchWithTimeout(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: requestBody,
  }, 10000);
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Stripe API error (${res.status})`);
    err.stripeError = json?.error;
    err.status = res.status;
    throw err;
  }
  return json;
}

// ── Verifica manuale della firma webhook (HMAC-SHA256 via Web Crypto) ──
// Necessaria perché il runtime Workers non supporta il modulo crypto sincrono di Node
// usato da stripe.webhooks.constructEvent(); qui implementiamo l'algoritmo documentato
// da Stripe per la verifica manuale (timestamp + firma v1).
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function verifyStripeSignature(payload, sigHeader, secret, toleranceSeconds = 300) {
  if (!sigHeader) return false;
  const parts = { v1: [] };
  for (const part of sigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 't') parts.t = v;
    else if (k === 'v1') parts.v1.push(v);
  }
  if (!parts.t || parts.v1.length === 0) return false;

  const timestamp = parseInt(parts.t, 10);
  if (!Number.isFinite(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;

  const signedPayload = `${parts.t}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expectedHex = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return parts.v1.some(sig => timingSafeEqualHex(sig, expectedHex));
}

// ── Finalizzazione ordine (idempotente) ──────────────────────────────
// Chiamata sia da stripe-finalize.js (subito dopo la conferma lato client)
// sia da stripe-webhook.js (rete di sicurezza asincrona). Entrambe le chiamate
// sono sicure da eseguire più volte: la dedup avviene sulla chiave
// `stripe:{paymentIntentId}` nel KV, esattamente come già avviene per PayPal
// con la chiave `paypal:{orderId}`.
//
// Ritorna { codiceVoucher, scadenza, giaEsistente } oppure lancia un errore.
export async function finalizeStripeOrder(paymentIntent, env, waitUntil) {
  const md = paymentIntent.metadata || {};
  const isLibero = md.tipo === 'libero';

  if (paymentIntent.status !== 'succeeded') {
    throw new Error(`PaymentIntent non è succeeded (status: ${paymentIntent.status})`);
  }

  // Dedup per payment_intent id — se già processato, ritorna il voucher esistente
  if (env.VOUCHERS) {
    const existingCode = await env.VOUCHERS.get(`stripe:${paymentIntent.id}`);
    if (existingCode) {
      const existingRecord = await env.VOUCHERS.get(`voucher:${existingCode}`, { type: 'json' });
      return {
        codiceVoucher: existingCode,
        scadenza: existingRecord?.scadenza || '',
        giaEsistente: true,
      };
    }
  }

  // L'importo è già fidato: il PaymentIntent è stato creato dal NOSTRO server
  // con l'amount calcolato server-side (vedi stripe-create-intent.js) — non
  // serve ricalcolarlo qui come si fa invece per PayPal (dove il client crea
  // l'ordine lato PayPal e va riverificato).
  const expectedAmount = paymentIntent.amount / 100;

  const codiceVoucher = generaCodice(isLibero ? 'libero' : 'fisso', md.numPortate ? parseInt(md.numPortate, 10) : null);
  const scadDate = new Date();
  scadDate.setFullYear(scadDate.getFullYear() + 1);
  const scadenza = scadDate.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });

  if (env.VOUCHERS) {
    const record = {
      codice: codiceVoucher,
      tipo: isLibero ? 'libero' : 'fisso',
      numPortate: isLibero ? null : parseInt(md.numPortate, 10),
      numPersone: isLibero ? null : parseInt(md.numPersone, 10),
      importoLibero: isLibero ? parseInt(md.importoLibero, 10) : 0,
      importoPagato: expectedAmount,
      origine: 'online',
      metodoPagamento: 'stripe',
      nomeAcquirente: md.nomeAcquirente || '',
      emailAcquirente: md.emailAcquirente || '',
      nomeDestinatario: md.nomeDestinatario || '',
      emailDestinatario: md.emailDestinatario || '',
      messaggioPersonale: md.messaggioPersonale || '',
      prodotto: md.prodotto || '',
      dataAcquisto: new Date().toISOString().split('T')[0],
      scadenza,
      stato: 'attivo',
      dataUtilizzo: null,
      stripePaymentIntentId: paymentIntent.id,
    };
    try {
      await env.VOUCHERS.put(`voucher:${codiceVoucher}`, JSON.stringify(record));
      await env.VOUCHERS.put(`stripe:${paymentIntent.id}`, codiceVoucher, { expirationTtl: 90 * 24 * 3600 });
    } catch (err) {
      console.error('KV write error (stripe):', err.message);
      if (env.RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: "L'800 Notifiche <info@l800.it>",
            to: ['info@l800.it'],
            subject: `⚠️ ERRORE KV — buono Stripe non salvato in dashboard: ${codiceVoucher}`,
            text: [
              `ATTENZIONE: pagamento Stripe riuscito ma il salvataggio nella dashboard ha fallito.`,
              `Aggiungilo manualmente dalla dashboard.`,
              ``,
              `Codice: ${codiceVoucher}`,
              `PaymentIntent: ${paymentIntent.id}`,
              `Importo: €${expectedAmount}`,
              `Acquirente: ${md.nomeAcquirente} <${md.emailAcquirente}>`,
              `Errore tecnico: ${err.message}`,
            ].join('\n'),
          }),
        }).catch(e => console.error('Alert KV error email failed:', e.message));
      }
    }
  }

  // Notifica interna
  if (env.RESEND_API_KEY) {
    const riepilogo = isLibero
      ? `Buono importo libero: €${md.importoLibero}`
      : `${md.prodotto} — ${md.numPersone} persone × ${md.numPortate} portate — €${expectedAmount}`;
    const send = fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: "L'800 Notifiche <info@l800.it>",
        to: ['info@l800.it'],
        subject: `🧾 Nuovo buono venduto (Stripe) — ${codiceVoucher}`,
        text: [
          `Nuovo buono regalo acquistato online con Stripe.`,
          ``,
          `Codice: ${codiceVoucher}`,
          `Prodotto: ${riepilogo}`,
          `Scadenza: ${scadenza}`,
          ``,
          `Acquirente: ${md.nomeAcquirente} <${md.emailAcquirente}>`,
          `Destinatario: ${md.nomeDestinatario}${md.emailDestinatario ? ` <${md.emailDestinatario}>` : ''}`,
          md.messaggioPersonale ? `Messaggio: "${md.messaggioPersonale}"` : '',
          ``,
          `Stripe PaymentIntent: ${paymentIntent.id}`,
        ].filter(s => s !== undefined && s !== '').join('\n'),
      }),
    }).catch(err => console.error('Email notifica interna (stripe) error:', err.message));
    if (waitUntil) waitUntil(send); else await send;
  }

  console.log('VOUCHER_SOLD_STRIPE', JSON.stringify({
    ts: new Date().toISOString(),
    codice: codiceVoucher,
    paymentIntentId: paymentIntent.id,
    importo: expectedAmount,
  }));

  // Meta Conversions API — stesso schema di send-voucher.js
  if (env.META_CAPI_TOKEN && env.META_PIXEL_ID && md.emailAcquirente) {
    async function hashEmail(email) {
      const encData = new TextEncoder().encode(email.trim().toLowerCase());
      const hashBuffer = await crypto.subtle.digest('SHA-256', encData);
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    const emailHash = await hashEmail(md.emailAcquirente);
    const capiSend = fetchWithTimeout(
      `https://graph.facebook.com/v19.0/${env.META_PIXEL_ID}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [{
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'website',
            event_source_url: 'https://www.l800.it/buoni.html',
            event_id: codiceVoucher,
            user_data: { em: [emailHash] },
            custom_data: {
              value: expectedAmount,
              currency: 'EUR',
              content_ids: [isLibero ? 'voucher_libero' : `voucher_${md.numPortate}portate`],
              content_type: 'product',
              num_items: isLibero ? 1 : parseInt(md.numPersone, 10),
            },
          }],
          access_token: env.META_CAPI_TOKEN,
        }),
      },
      10000
    ).then(r => r.json()).then(j => console.log('META_CAPI_STRIPE', JSON.stringify(j)))
      .catch(err => console.error('Meta CAPI (stripe) error:', err.message));
    if (waitUntil) waitUntil(capiSend); else await capiSend;
  }

  return { codiceVoucher, scadenza, giaEsistente: false };
}
