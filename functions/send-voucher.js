// Cloudflare Pages Function: send-voucher
// File: functions/send-voucher.js  →  Endpoint: POST /send-voucher
// Runtime: Cloudflare Workers (V8) — fetch nativo, niente Node.js
// Env var: RESEND_API_KEY (Pages > Settings > Environment variables)
//          PAYPAL_CLIENT_ID, PAYPAL_SECRET (per verifica server-side ordini)
//          ALLOWED_ORIGIN (default https://www.l800.it)

const RESEND_URL = 'https://api.resend.com/emails';
const PAYPAL_API = 'https://api-m.paypal.com';   // produzione PayPal
const MAX_PDF_BYTES = 2 * 1024 * 1024;           // 2 MB hard cap base64-decoded
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Helper: fetch con timeout esplicito per prevenire 504 Gateway Timeout.
// I Workers Cloudflare hanno 30s di wall clock; PayPal e Resend di solito rispondono
// in <3s ma in caso di lentezza esterna vogliamo fallire in modo ordinato.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Timeout dopo ${timeoutMs}ms: ${url}`);
    }
    throw err;
  }
}

// Rate limiting in-memory per istanza (Cloudflare Workers riavvia spesso,
// ma protegge contro burst da stesso IP entro la stessa istanza)
const ipHits = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 5;

function buildCors(origin) {
  // Sempre restrittivo: l'origin di l800.it (o www) viene riflesso, gli altri vengono bloccati
  const allowed = ['https://www.l800.it', 'https://l800.it'];
  const allowOrigin = allowed.includes(origin) ? origin : 'https://www.l800.it';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function jsonResponse(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// ── Preflight CORS ──────────────────────────────────────────────────
export async function onRequestOptions({ request }) {
  return new Response(null, { status: 200, headers: buildCors(request.headers.get('Origin')) });
}

// === Listino prezzi server-side (anti-frode) ===
// I prezzi NON vengono mai presi dal client. Il client dichiara numPortate
// e numPersone; l'importo atteso viene calcolato qui e confrontato con
// quello effettivamente addebitato da PayPal.
const PREZZI_VOUCHER = { 3: 50, 4: 65 };  // €/persona

// === Buono a importo libero ===
// Minimo di business €25; nessun tetto massimo lato business, ma una guardia
// tecnica anti-abuso/overflow a 5000€ (importi superiori → contatto diretto).
const IMPORTO_LIBERO_MIN = 25;
const IMPORTO_LIBERO_MAX_TECNICO = 5000;

function calcolaImportoAtteso(numPortate, numPersone) {
  const prezzoUnit = PREZZI_VOUCHER[numPortate];
  if (!prezzoUnit) return null;
  const persone = parseInt(numPersone, 10);
  if (!Number.isFinite(persone) || persone < 1 || persone > 200) return null;
  return prezzoUnit * persone;
}

// ── Verifica server-side dell'ordine PayPal ──────────────────────────
// Recupera l'access token e poi i dettagli dell'ordine. Restituisce
// { ok: true } se l'ordine esiste, è COMPLETED, e l'importo coincide con
// expectedAmount. Altrimenti { ok: false, reason: '...' }.
async function verifyPaypalOrder(orderId, expectedAmount, env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_SECRET) {
    // SECURITY: se le credenziali mancano NON saltiamo la verifica.
    // Senza credenziali la verifica non è possibile → l'ordine è da ritenere non verificato.
    console.error('SECURITY: PayPal credentials mancanti — verifica impossibile, blocco l\'invio.');
    return { ok: false, reason: 'verifica_disabilitata' };
  }
  try {
    const basic = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`);
    const tokenR = await fetchWithTimeout(`${PAYPAL_API}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!tokenR.ok) {
      console.error('PayPal token fail:', tokenR.status);
      return { ok: false, reason: 'auth_failed' };
    }
    const { access_token } = await tokenR.json();
    const orderR = await fetchWithTimeout(`${PAYPAL_API}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });
    if (!orderR.ok) {
      console.error('PayPal order fail:', orderR.status, orderId);
      return { ok: false, reason: 'order_not_found' };
    }
    const order = await orderR.json();
    if (!order || order.status !== 'COMPLETED') {
      return { ok: false, reason: `order_status_${order?.status || 'unknown'}` };
    }

    // SECURITY CRITICAL: controlla che l'importo pagato corrisponda all'atteso
    const pu = Array.isArray(order.purchase_units) ? order.purchase_units[0] : null;
    const amtRaw = pu?.amount?.value;
    const amtCurrency = pu?.amount?.currency_code;
    const amtPaid = parseFloat(amtRaw);

    if (amtCurrency !== 'EUR') {
      console.error('PayPal currency mismatch:', amtCurrency, 'expected EUR');
      return { ok: false, reason: 'currency_mismatch' };
    }
    if (!Number.isFinite(amtPaid)) {
      console.error('PayPal amount non parseable:', amtRaw);
      return { ok: false, reason: 'amount_invalid' };
    }
    // tolleranza 0.01€ per arrotondamenti
    if (Math.abs(amtPaid - expectedAmount) > 0.01) {
      console.error('SECURITY: PayPal amount mismatch.', JSON.stringify({
        orderId, paid: amtPaid, expected: expectedAmount, diff: amtPaid - expectedAmount,
      }));
      return { ok: false, reason: 'amount_mismatch' };
    }

    return { ok: true };
  } catch (err) {
    console.error('verifyPaypalOrder error:', err.message);
    return { ok: false, reason: 'exception' };
  }
}

// ── Sanifica stringhe usate negli header (subject Reply-To)
//    Rimuove CR/LF per prevenire header injection
function sanHeader(s, maxLen = 200) {
  return String(s || '').replace(/[\r\n]+/g, ' ').slice(0, maxLen);
}

// ── Generazione codice voucher lato server (Fix 4)
// Formato: L800-{N}P-{rand4}{ts4} per tagli fissi, L800-LIB-{rand4}{ts4} per importo libero
// Stesso charset dell'ex-client: esclude O/0/I/1 per leggibilità
function generaCodice(tipo, numPortate) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  let rand = '';
  for (let i = 0; i < 4; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  const prefix = tipo === 'libero' ? 'LIB' : `${numPortate}P`;
  return `L800-${prefix}-${rand}${ts}`;
}

// ── Versione text/plain delle email (anti-spam, accessibilità)
function textAcquirente(d) {
  const isLibero = d.tipo === 'libero';
  const validoPer = isLibero
    ? `Valore: € ${d.importoLibero}`
    : `Valido per: ${d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`}`;
  return [
    `Ciao ${d.nomeAcquirente},`,
    '',
    `Hai regalato un'esperienza all'L'800 Locanda a Palazzo.`,
    `In allegato trovi il Buono Regalo in formato PDF.`,
    '',
    `Riepilogo:`,
    `  Prodotto: ${d.prodotto}`,
    `  ${validoPer}`,
    `  Codice: ${d.codiceVoucher}`,
    `  Scadenza: ${d.scadenza}`,
    `  Destinatario: ${d.nomeDestinatario}`,
    `  ID PayPal: ${d.paypalOrderId}`,
    '',
    d.messaggioPersonale ? `Messaggio: "${d.messaggioPersonale}"\n` : '',
    `Per prenotare:`,
    `  WhatsApp: https://wa.me/390982428262`,
    `  Octotable: https://octotable.com/book/restaurant/561331/booking/home`,
    `  Telefono: +39 0982 428262`,
    '',
    `--`,
    `L'800 Locanda a Palazzo`,
    `Via Calavecchia 53, 87032 Amantea (CS)`,
    `info@l800.it · https://www.l800.it`,
  ].filter(Boolean).join('\n');
}

function textDestinatario(d) {
  const isLibero = d.tipo === 'libero';
  const rigaBuono = isLibero
    ? `  Buono Regalo del valore di € ${d.importoLibero}`
    : `  ${d.prodotto}\n  Valido per: ${d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`}`;
  return [
    `Ciao ${d.nomeDestinatario},`,
    '',
    `${d.nomeAcquirente} ti ha fatto un regalo speciale: una cena all'L'800 Locanda a Palazzo,`,
    `nel cuore di Amantea, sulla costa tirrenica calabrese.`,
    '',
    d.messaggioPersonale ? `Il messaggio: "${d.messaggioPersonale}"\n` : '',
    `Il tuo Buono Regalo:`,
    rigaBuono,
    `  Codice: ${d.codiceVoucher}`,
    `  Scadenza: ${d.scadenza}`,
    '',
    isLibero ? `Potrai utilizzarlo sul conto della tua cena, scegliendo liberamente dal nostro menu.\n` : '',
    `Per prenotare il tuo tavolo:`,
    `  WhatsApp: https://wa.me/390982428262`,
    `  Octotable: https://octotable.com/book/restaurant/561331/booking/home`,
    `  Telefono: +39 0982 428262`,
    '',
    `--`,
    `L'800 Locanda a Palazzo`,
    `Via Calavecchia 53, 87032 Amantea (CS)`,
  ].filter(Boolean).join('\n');
}

// ── POST /send-voucher ──────────────────────────────────────────────
export async function onRequestPost({ request, env, waitUntil }) {

  const origin = request.headers.get('Origin');
  const cors = buildCors(origin);

  // 0. Controllo origin (CORS strict). Se l'origin non è autorizzato, rifiuto.
  if (origin && !['https://www.l800.it', 'https://l800.it'].includes(origin)) {
    console.warn('Origin non autorizzato:', origin);
    return jsonResponse({ error: 'Origin non autorizzato' }, 403, cors);
  }

  // 0b. Rate limiting basico per IP
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const hist = (ipHits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hist.length >= RATE_MAX_HITS) {
    return jsonResponse({ error: 'Troppe richieste, riprova tra qualche minuto.' }, 429, cors);
  }
  hist.push(now);
  ipHits.set(ip, hist);

  // 1. API key Resend
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY mancante nelle variabili d\'ambiente');
    return jsonResponse({ error: 'Configurazione server mancante' }, 500, cors);
  }

  // 2. Parsa il body JSON
  let d;
  try {
    d = await request.json();
  } catch {
    return jsonResponse({ error: 'Body JSON non valido' }, 400, cors);
  }

  // 3. Valida i campi obbligatori
  //    Per il buono a importo libero numPortate/numPersone non si applicano.
  const isLibero = d.tipo === 'libero';
  // codiceVoucher, scadenza e pdfBase64 non sono più richiesti dal client:
  // il codice e la scadenza vengono generati lato server; il PDF non è allegato alle email.
  const required = isLibero
    ? ['nomeAcquirente', 'emailAcquirente', 'nomeDestinatario',
       'prodotto', 'importoLibero', 'paypalOrderId']
    : ['nomeAcquirente', 'emailAcquirente', 'nomeDestinatario',
       'prodotto', 'numPortate', 'numPersone', 'paypalOrderId'];
  for (const field of required) {
    if (!d[field] && d[field] !== 0) {
      return jsonResponse({ error: `Campo obbligatorio mancante: ${field}` }, 400, cors);
    }
  }

  // 3b. Validazione formato email (server-side, oltre al client-side)
  if (!EMAIL_RX.test(String(d.emailAcquirente).trim())) {
    return jsonResponse({ error: 'Email acquirente non valida' }, 400, cors);
  }
  if (d.emailDestinatario && String(d.emailDestinatario).trim() && !EMAIL_RX.test(String(d.emailDestinatario).trim())) {
    return jsonResponse({ error: 'Email destinatario non valida' }, 400, cors);
  }

  // 4. Sanificazioni + calcolo importo atteso (anti-frode: l'importo NON è preso dal client come "verità di pagamento")
  let expectedAmount;
  if (isLibero) {
    // Importo libero: intero, minimo €25. Guardia tecnica anti-abuso a 5000€ (non è un tetto di business).
    const imp = parseInt(d.importoLibero, 10);
    if (!Number.isInteger(imp) || imp < IMPORTO_LIBERO_MIN || imp > IMPORTO_LIBERO_MAX_TECNICO) {
      return jsonResponse({ error: 'Importo libero non valido' }, 400, cors);
    }
    d.importoLibero = imp;
    expectedAmount = imp;
  } else {
    d.numPersone = parseInt(d.numPersone, 10) || 1;
    if (d.numPersone < 1 || d.numPersone > 200) d.numPersone = 1;
    d.numPortate = parseInt(d.numPortate, 10);
    if (![3, 4].includes(d.numPortate)) {
      return jsonResponse({ error: 'numPortate non valido (atteso 3 o 4)' }, 400, cors);
    }
    // 4a. Calcolo importo atteso server-side (il prezzo NON viene preso dal client)
    expectedAmount = calcolaImportoAtteso(d.numPortate, d.numPersone);
    if (expectedAmount == null) {
      return jsonResponse({ error: 'Impossibile calcolare importo atteso' }, 400, cors);
    }
  }

  // 4b. Verifica server-side dell'ordine PayPal (anti-frode):
  //     - ordine esiste, è COMPLETED, in EUR, e l'importo coincide con quello atteso
  const paypalResult = await verifyPaypalOrder(d.paypalOrderId, expectedAmount, env);
  if (!paypalResult.ok) {
    console.error('Pagamento rifiutato:', paypalResult.reason, 'orderId:', d.paypalOrderId);
    return jsonResponse({ error: 'Ordine PayPal non valido', reason: paypalResult.reason }, 402, cors);
  }

  // 4c. Deduplicazione per paypalOrderId (Fix 1): protegge contro doppio invio
  // La chiave paypal: viene scritta nel KV solo dopo verifica PayPal riuscita,
  // quindi è sicuro restituire il voucher esistente senza ri-verificare.
  if (env.VOUCHERS) {
    try {
      const existingCode = await env.VOUCHERS.get(`paypal:${d.paypalOrderId}`);
      if (existingCode) {
        console.log('VOUCHER_DEDUP', JSON.stringify({ orderId: d.paypalOrderId, code: existingCode }));
        const existingRecord = await env.VOUCHERS.get(`voucher:${existingCode}`, { type: 'json' });
        return jsonResponse({
          success: true,
          codiceVoucher: existingCode,
          scadenza: existingRecord?.scadenza || '',
        }, 200, cors);
      }
    } catch (err) {
      console.warn('Dedup check error:', err.message);
    }
  }

  // 4d. Generazione codice e scadenza lato server (Fix 4)
  d.codiceVoucher = generaCodice(isLibero ? 'libero' : 'fisso', d.numPortate);
  const scadDate = new Date();
  scadDate.setFullYear(scadDate.getFullYear() + 1);
  d.scadenza = scadDate.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // 6. Subject sanitizzato per prevenire header injection
  const subjAcq = sanHeader(`Il tuo Buono Regalo L'800 \u2714`);
  const subjDest = sanHeader(`${d.nomeAcquirente} ti ha fatto un regalo speciale \uD83C\uDF81`);
  const replyTo = 'info@l800.it';

  // 7. Email all'acquirente (await — bloccante)
  let r1;
  try {
    r1 = await fetchWithTimeout(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: "L'800 Locanda a Palazzo <info@l800.it>",
        to: [d.emailAcquirente],
        reply_to: replyTo,
        subject: subjAcq,
        html: htmlAcquirente(d),
        text: textAcquirente(d),
      }),
    });
  } catch (err) {
    console.error('Fetch Resend (acquirente) error:', err.message);
    return jsonResponse({ error: 'Errore di rete: ' + err.message }, 502, cors);
  }

  if (!r1.ok) {
    const errText = await r1.text();
    console.error('Resend API error (acquirente):', r1.status, errText);
    // Gestione esplicita 429 da Resend (rate limit)
    if (r1.status === 429) {
      return jsonResponse({ error: 'Servizio email temporaneamente sovraccarico, riprova tra qualche minuto.' }, 503, cors);
    }
    return jsonResponse({ error: 'Invio email fallito', detail: errText }, 500, cors);
  }

  // 8. Email al destinatario in background
  const emailDestValida =
    d.emailDestinatario &&
    EMAIL_RX.test(String(d.emailDestinatario).trim()) &&
    d.emailDestinatario.trim().toLowerCase() !== d.emailAcquirente.trim().toLowerCase();

  if (emailDestValida) {
    waitUntil(
      fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: "L'800 Locanda a Palazzo <info@l800.it>",
          to: [d.emailDestinatario],
          reply_to: replyTo,
          subject: subjDest,
          html: htmlDestinatario(d),
          text: textDestinatario(d),
        }),
      }).catch(err => console.error('Email destinatario error:', err.message))
    );
  }

  // 8b. Notifica interna a info@l800.it
  const isLiberoNotifica = d.tipo === 'libero';
  const riepilogoNotifica = isLiberoNotifica
    ? `Buono importo libero: €${d.importoLibero}`
    : `${d.prodotto} — ${d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`} × ${d.numPortate} portate — €${expectedAmount}`;
  waitUntil(
    fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: "L'800 Notifiche <info@l800.it>",
        to: ['info@l800.it'],
        subject: `🧾 Nuovo buono venduto — ${d.codiceVoucher}`,
        text: [
          `Nuovo buono regalo acquistato online.`,
          ``,
          `Codice: ${d.codiceVoucher}`,
          `Prodotto: ${riepilogoNotifica}`,
          `Scadenza: ${d.scadenza}`,
          ``,
          `Acquirente: ${d.nomeAcquirente} <${d.emailAcquirente}>`,
          `Destinatario: ${d.nomeDestinatario}${d.emailDestinatario ? ` <${d.emailDestinatario}>` : ''}`,
          d.messaggioPersonale ? `Messaggio: "${d.messaggioPersonale}"` : '',
          ``,
          `PayPal Order ID: ${d.paypalOrderId}`,
        ].filter(s => s !== undefined).join('\n'),
      }),
    }).catch(err => console.error('Email notifica interna error:', err.message))
  );

  // 8c. Log strutturato vendita (consultabile da Cloudflare > Logs / Logpush)
  console.log('VOUCHER_SOLD', JSON.stringify({
    ts: new Date().toISOString(),
    codice: d.codiceVoucher,
    prodotto: d.prodotto,
    numPersone: d.numPersone,
    scadenza: d.scadenza,
    paypalOrderId: d.paypalOrderId,
    acquirente: { nome: d.nomeAcquirente, email: d.emailAcquirente },
    destinatario: { nome: d.nomeDestinatario, email: d.emailDestinatario || null },
    inviato_destinatario: emailDestValida,
  }));

  // 8c. Salvataggio nel KV VOUCHERS per la dashboard
  if (env.VOUCHERS) {
    const record = {
      codice:            d.codiceVoucher,
      tipo:              isLibero ? 'libero' : 'fisso',
      numPortate:        isLibero ? null : d.numPortate,
      numPersone:        isLibero ? null : d.numPersone,
      importoLibero:     isLibero ? d.importoLibero : 0,
      importoPagato:     expectedAmount,
      origine:           'online',
      nomeAcquirente:    d.nomeAcquirente,
      emailAcquirente:   d.emailAcquirente,
      nomeDestinatario:  d.nomeDestinatario,
      emailDestinatario: d.emailDestinatario || '',
      messaggioPersonale:d.messaggioPersonale || '',
      prodotto:          d.prodotto,
      dataAcquisto:      new Date().toISOString().split('T')[0],
      scadenza:          d.scadenza,
      stato:             'attivo',
      dataUtilizzo:      null,
      paypalOrderId:     d.paypalOrderId,
    };
    waitUntil(
      env.VOUCHERS.put(`voucher:${d.codiceVoucher}`, JSON.stringify(record))
        // Fix 1: salva chiave dedup paypalOrderId → codiceVoucher (TTL 90 giorni)
        .then(() => env.VOUCHERS.put(`paypal:${d.paypalOrderId}`, d.codiceVoucher, { expirationTtl: 90 * 24 * 3600 }))
        .catch(err => {
          console.error('KV write error:', err.message);
          // Alert email a info@l800.it se il salvataggio nel KV fallisce
          return fetch(RESEND_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: "L'800 Notifiche <info@l800.it>",
              to: ['info@l800.it'],
              subject: `⚠️ ERRORE KV — buono non salvato in dashboard: ${d.codiceVoucher}`,
              text: [
                `ATTENZIONE: il buono è stato venduto e l'email all'acquirente è stata inviata,`,
                `ma il salvataggio nella dashboard ha fallito.`,
                `Aggiungilo manualmente dalla dashboard.`,
                ``,
                `Codice: ${d.codiceVoucher}`,
                `Prodotto: ${d.prodotto}`,
                `Acquirente: ${d.nomeAcquirente} <${d.emailAcquirente}>`,
                `Destinatario: ${d.nomeDestinatario}`,
                `PayPal Order ID: ${d.paypalOrderId}`,
                `Importo: €${expectedAmount}`,
                ``,
                `Errore tecnico: ${err.message}`,
              ].join('\n'),
            }),
          }).catch(e => console.error('Alert KV error email failed:', e.message));
        })
    );
  }

  // 8c. Meta Conversions API — evento Purchase server-side
  // Più affidabile del Pixel client-side su iOS e con ad blocker.
  // Richiede: env.META_CAPI_TOKEN (System User Access Token da Meta Business Suite)
  //           env.META_PIXEL_ID  (1266689621145892 — già noto)
  // Se le env var non sono configurate, l'invio viene saltato silenziosamente.
  if (env.META_CAPI_TOKEN && env.META_PIXEL_ID) {
    const prezziUnitari = { 3: 50, 4: 65 };
    const prezzoUnitario = prezziUnitari[d.numPortate] || 0;
    const valore = prezzoUnitario * d.numPersone;

    // Hash SHA-256 dell'email (richiesto da Meta per matching)
    async function hashEmail(email) {
      const encoder = new TextEncoder();
      const data = encoder.encode(email.trim().toLowerCase());
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const emailHash = await hashEmail(d.emailAcquirente);

    waitUntil(
      fetchWithTimeout(
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
              event_id: d.codiceVoucher,              // deduplication con Pixel client-side
              user_data: {
                em: [emailHash],                       // email hashed SHA-256
              },
              custom_data: {
                value: valore,
                currency: 'EUR',
                content_ids: [`voucher_${d.numPortate}portate`],
                content_type: 'product',
                num_items: d.numPersone,
              },
            }],
            access_token: env.META_CAPI_TOKEN,
            // test_event_code: 'TEST12345',           // ← decommenta solo in fase di test
          }),
        },
        10000
      ).then(r => r.json())
        .then(j => console.log('META_CAPI', JSON.stringify(j)))
        .catch(err => console.error('Meta CAPI error:', err.message))
    );
  }

  // 9. Risposta di successo — include codiceVoucher e scadenza (Fix 4)
  return jsonResponse({ success: true, codiceVoucher: d.codiceVoucher, scadenza: d.scadenza }, 200, cors);
}

function htmlAcquirente(d) {
  const isLibero = d.tipo === 'libero';
  const persone = d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`;
  // Etichetta "validità" condizionale: valore in € per il buono libero, persone per i tagli fissi
  const validitaLabel = isLibero ? `un valore di <strong style="color:#fbf7ef;font-size:15px;">&euro; ${d.importoLibero}</strong>` : `Valido per <strong style="color:#fbf7ef;font-size:15px;">${persone}</strong>`;
  const validitaFrase = isLibero ? `del valore di &euro; ${d.importoLibero}, da scalare sul conto,` : `valido per ${persone}`;
  const msgBlock = d.messaggioPersonale
    ? `<div style="border-left:3px solid #d9b988;padding:12px 18px;margin:24px 0;background:#fbf7ef;">
         <div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:2px;color:#8a5630;text-transform:uppercase;margin-bottom:8px;">Il tuo messaggio</div>
         <p style="font-family:Georgia,serif;font-size:15px;font-style:italic;color:#807068;margin:0;line-height:1.75;">&ldquo;${esc(d.messaggioPersonale)}&rdquo;</p>
       </div>` : '';

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Il tuo Buono Regalo L'800</title></head>
<body style="margin:0;padding:0;background:#ecd9b6;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:580px;margin:0 auto;">

  <div style="background:#4a2612;padding:40px 48px 32px;text-align:center;">
    <div style="font-size:40px;font-style:italic;color:#fbf7ef;letter-spacing:1px;">L&rsquo;800</div>
    <div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:4px;color:#d9b988;text-transform:uppercase;margin-top:6px;">Locanda a Palazzo &middot; Amantea</div>
  </div>

  <div style="background:#fbf7ef;padding:44px 48px 8px;">
    <p style="font-size:18px;color:#2a1a10;margin:0 0 8px;">Ciao <strong>${esc(d.nomeAcquirente)}</strong>,</p>
    <p style="font-size:16px;font-style:italic;color:#807068;line-height:1.8;margin:0 0 24px;">
      hai regalato un&rsquo;esperienza che vale un ricordo.
    </p>
    <p style="font-size:15px;color:#807068;line-height:1.8;margin:0 0 28px;">
      In allegato trovi il <strong style="color:#2a1a10;">Buono Regalo L&rsquo;800</strong> in formato PDF &mdash;
      pronto da stampare, inviare o consegnare a mano.<br>
      Per utilizzarlo basta prenotare un tavolo: pensiamo noi al resto.
    </p>

    ${msgBlock}

    <div style="background:#4a2612;padding:28px 32px;margin-bottom:28px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;letter-spacing:3px;color:#d9b988;text-transform:uppercase;margin-bottom:14px;">Riepilogo acquisto</div>
      <div style="font-family:Georgia,serif;font-size:17px;font-style:italic;color:#fbf7ef;margin-bottom:4px;">${esc(d.prodotto)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1.5px;color:#d9b988;text-transform:uppercase;margin-bottom:18px;padding:8px 12px;background:rgba(255,255,255,0.08);">${validitaLabel}</div>
      <div style="border-top:1px dashed rgba(217,185,136,0.3);padding-top:18px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;letter-spacing:2.5px;color:#d9b988;text-transform:uppercase;margin-bottom:8px;">Codice voucher</div>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:bold;color:#fbf7ef;letter-spacing:3px;">${d.codiceVoucher}</div>
        <div style="font-family:Georgia,serif;font-size:11px;font-style:italic;color:rgba(251,247,239,0.5);margin-top:8px;">Valido fino al ${d.scadenza}</div>
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
      <tr><td style="padding:9px 0;border-bottom:1px solid rgba(111,59,28,0.1);font-size:13px;color:#8a5630;width:38%;">Destinatario</td>
          <td style="padding:9px 0;border-bottom:1px solid rgba(111,59,28,0.1);font-size:14px;font-weight:bold;color:#2a1a10;">${esc(d.nomeDestinatario)}</td></tr>
      <tr><td style="padding:9px 0;font-size:13px;color:#8a5630;">ID transazione</td>
          <td style="padding:9px 0;font-size:11px;color:#8a5630;font-family:monospace;">${d.paypalOrderId}</td></tr>
    </table>

    <div style="background:#ecd9b6;padding:20px 24px;margin-bottom:28px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:2px;color:#8a5630;text-transform:uppercase;margin-bottom:10px;">Come utilizzare il buono</div>
      <p style="font-size:14px;color:#807068;line-height:1.7;margin:0 0 10px;">
        Per prenotare, il destinatario pu&ograve; scriverci su WhatsApp, chiamarci al 0982 428262 o prenotare direttamente online tramite Octotable. Al momento di presentarsi al ristorante, sar&agrave; sufficiente comunicare il codice voucher.
      </p>
      <p style="font-size:14px;color:#807068;line-height:1.7;margin:0;">
        Il buono &egrave; ${validitaFrase} per 12 mesi dall&rsquo;acquisto.
      </p>
    </div>

    <p style="font-size:14px;color:#807068;line-height:1.8;margin:0 0 12px;">${
      d.emailDestinatario && d.emailDestinatario.includes('@') && d.emailDestinatario.trim().toLowerCase() !== d.emailAcquirente.trim().toLowerCase()
        ? 'Abbiamo gi&agrave; inviato una copia del buono a <strong style="color:#2a1a10;">' + esc(d.emailDestinatario) + '</strong>. Puoi comunque condividere anche il PDF allegato a questa email.'
        : 'Condividi il PDF allegato a questa email con il destinatario per consegnargli il buono.'
    }</p>
    <p style="font-size:14px;color:#807068;line-height:1.8;margin:0 0 12px;">Per prenotare, il destinatario pu&ograve; contattarci tramite:</p>
    <table style="border-collapse:collapse;margin-bottom:16px;">
      <tr>
        <td style="padding-right:12px;"><a href="https://wa.me/390982428262" style="display:inline-block;background:#2e7d32;color:#fff;font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;padding:11px 22px;text-decoration:none;">WhatsApp</a></td>
        <td><a href="https://octotable.com/book/restaurant/561331/booking/home" style="display:inline-block;border:1px solid #6f3b1c;color:#6f3b1c;font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;padding:11px 22px;text-decoration:none;">Octotable</a></td>
      </tr>
    </table>
    <p style="font-size:13px;color:#8a5630;margin:0 0 36px;">oppure chiama il <a href="tel:+390982428262" style="color:#6f3b1c;">0982 428262</a></p>
  </div>

  <div style="background:#fbf7ef;padding:0 48px 36px;">
    <div style="border-top:1px solid rgba(111,59,28,0.12);padding-top:24px;">
      <div style="font-size:20px;font-style:italic;color:#6f3b1c;">L&rsquo;800</div>
      <div style="font-family:Helvetica,sans-serif;font-size:8px;letter-spacing:2px;color:#8a5630;text-transform:uppercase;margin-top:3px;">Locanda a Palazzo</div>
      <p style="font-size:12px;color:#8a5630;margin:8px 0 0;line-height:1.6;">
        Via Calavecchia 53 &middot; 87032 Amantea (CS)<br>
        <a href="tel:+390982428262" style="color:#6f3b1c;">+39 0982 428262</a> &middot;
        <a href="mailto:info@l800.it" style="color:#6f3b1c;">info@l800.it</a> &middot;
        <a href="https://www.l800.it" style="color:#6f3b1c;">www.l800.it</a>
      </p>
    </div>
  </div>

  <div style="background:#6f3b1c;padding:16px 48px;text-align:center;">
    <p style="font-family:Helvetica,sans-serif;font-size:9px;color:rgba(251,247,239,0.5);margin:0;letter-spacing:1px;">Il mare, il palazzo, la Calabria.</p>
  </div>

</div></body></html>`;
}

// =============================================================================
// TEMPLATE EMAIL DESTINATARIO
// Tono: sorpresa ed emozione. Introduce L'800 a chi (forse) non lo conosce.
// =============================================================================
function htmlDestinatario(d) {
  const isLibero = d.tipo === 'libero';
  const persone = d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`;
  // Per il buono libero il box mostra il valore in €; per i tagli fissi le persone
  const prodottoLabel = isLibero ? 'Buono Regalo' : esc(d.prodotto);
  const validitaLabel = isLibero ? `un valore di <strong style="color:#fbf7ef;font-size:15px;">&euro; ${d.importoLibero}</strong>` : `Valido per <strong style="color:#fbf7ef;font-size:15px;">${persone}</strong>`;
  const usoFrase = isLibero
    ? 'Potrai utilizzarlo sul conto della tua cena, scegliendo liberamente dal nostro menu.'
    : '';
  const msgBlock = d.messaggioPersonale
    ? `<div style="border-left:3px solid #d9b988;padding:14px 20px;margin:24px 0;background:#fbf7ef;">
         <p style="font-family:Georgia,serif;font-size:17px;font-style:italic;color:#807068;margin:0 0 10px;line-height:1.75;">&ldquo;${esc(d.messaggioPersonale)}&rdquo;</p>
         <div style="font-size:13px;font-style:italic;color:#8a5630;">&mdash; ${esc(d.nomeAcquirente)}</div>
       </div>`
    : `<p style="font-size:15px;font-style:italic;color:#807068;line-height:1.8;margin:0 0 24px;">Con affetto, da <strong style="color:#2a1a10;">${esc(d.nomeAcquirente)}</strong>.</p>`;

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Un regalo per te &mdash; L'800</title></head>
<body style="margin:0;padding:0;background:#ecd9b6;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:580px;margin:0 auto;">

  <div style="background:#4a2612;padding:40px 48px 32px;text-align:center;">
    <div style="font-size:40px;font-style:italic;color:#fbf7ef;letter-spacing:1px;">L&rsquo;800</div>
    <div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:4px;color:#d9b988;text-transform:uppercase;margin-top:6px;">Locanda a Palazzo &middot; Amantea</div>
  </div>

  <div style="background:#fbf7ef;padding:44px 48px 8px;">
    <p style="font-size:18px;color:#2a1a10;margin:0 0 8px;">Ciao <strong>${esc(d.nomeDestinatario)}</strong>,</p>
    <p style="font-size:16px;font-style:italic;color:#807068;line-height:1.8;margin:0 0 20px;">
      <strong style="color:#2a1a10;">${esc(d.nomeAcquirente)}</strong> ti ha fatto un regalo che vale una serata.
    </p>

    ${msgBlock}

    <div style="background:#ecd9b6;padding:22px 24px;margin:0 0 28px;">
      <p style="font-size:14px;color:#807068;line-height:1.8;margin:0;">
        Ti aspetta una cena all&rsquo;<strong>L&rsquo;800 Locanda a Palazzo</strong> &mdash;
        un palazzo dell&rsquo;Ottocento nel centro storico di Amantea, sulla costa tirrenica calabrese.
        Il pescato fresco del Tirreno, un giardino in cui il tempo rallenta, e l&rsquo;eleganza discreta
        di chi sa che ogni dettaglio conta.
      </p>
    </div>

    <div style="background:#4a2612;padding:28px 32px;margin-bottom:28px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;letter-spacing:3px;color:#d9b988;text-transform:uppercase;margin-bottom:14px;">Il tuo Buono Regalo</div>
      <div style="font-family:Georgia,serif;font-size:18px;font-style:italic;color:#fbf7ef;margin-bottom:4px;">${prodottoLabel}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1.5px;color:#d9b988;text-transform:uppercase;margin-bottom:18px;padding:8px 12px;background:rgba(255,255,255,0.08);">${validitaLabel}</div>
      <div style="border-top:1px dashed rgba(217,185,136,0.3);padding-top:18px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;letter-spacing:2.5px;color:#d9b988;text-transform:uppercase;margin-bottom:8px;">Codice voucher</div>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:bold;color:#fbf7ef;letter-spacing:3px;">${d.codiceVoucher}</div>
        <div style="font-family:Georgia,serif;font-size:11px;font-style:italic;color:rgba(251,247,239,0.5);margin-top:8px;">Valido fino al ${d.scadenza}</div>
      </div>
    </div>

    <p style="font-size:14px;color:#807068;line-height:1.8;margin:0 0 18px;">
      ${usoFrase ? usoFrase + ' ' : ''}Presenta il codice al momento del pagamento.
    </p>

    <!-- CTA PRINCIPALE -->
    <div style="text-align:center;margin:0 0 24px;">
      <a href="https://wa.me/390982428262?text=Ciao%2C%20vorrei%20prenotare%20usando%20il%20buono%20regalo%20${encodeURIComponent(d.codiceVoucher)}" style="display:inline-block;background:#2e7d32;color:#fff;font-family:Helvetica,Arial,sans-serif;font-size:14px;letter-spacing:1.8px;text-transform:uppercase;padding:16px 36px;text-decoration:none;font-weight:bold;">Prenota il tuo tavolo →</a>
    </div>

    <p style="text-align:center;font-size:12px;color:#8a5630;margin:0 0 16px;">oppure</p>

    <table style="border-collapse:collapse;margin-bottom:16px;width:100%;">
      <tr>
        <td style="padding-right:8px;width:50%;"><a href="https://octotable.com/book/restaurant/561331/booking/home" style="display:block;text-align:center;border:1px solid #6f3b1c;color:#6f3b1c;font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;padding:11px 18px;text-decoration:none;">Prenota su Octotable</a></td>
        <td style="padding-left:8px;width:50%;"><a href="tel:+390982428262" style="display:block;text-align:center;border:1px solid #6f3b1c;color:#6f3b1c;font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;padding:11px 18px;text-decoration:none;">Chiama</a></td>
      </tr>
    </table>
    <p style="font-size:13px;color:#8a5630;margin:0 0 36px;">oppure chiama il <a href="tel:+390982428262" style="color:#6f3b1c;">0982 428262</a></p>
  </div>

  <div style="background:#fbf7ef;padding:0 48px 36px;">
    <div style="border-top:1px solid rgba(111,59,28,0.12);padding-top:24px;">
      <div style="font-size:20px;font-style:italic;color:#6f3b1c;">L&rsquo;800</div>
      <div style="font-family:Helvetica,sans-serif;font-size:8px;letter-spacing:2px;color:#8a5630;text-transform:uppercase;margin-top:3px;">Locanda a Palazzo</div>
      <p style="font-size:12px;color:#8a5630;margin:8px 0 0;line-height:1.6;">
        Via Calavecchia 53 &middot; 87032 Amantea (CS)<br>
        <a href="tel:+390982428262" style="color:#6f3b1c;">+39 0982 428262</a> &middot;
        <a href="mailto:info@l800.it" style="color:#6f3b1c;">info@l800.it</a> &middot;
        <a href="https://www.l800.it" style="color:#6f3b1c;">www.l800.it</a>
      </p>
    </div>
  </div>

  <div style="background:#6f3b1c;padding:16px 48px;text-align:center;">
    <p style="font-family:Helvetica,sans-serif;font-size:9px;color:rgba(251,247,239,0.5);margin:0;letter-spacing:1px;">Il mare, il palazzo, la Calabria.</p>
  </div>

</div></body></html>`;
}

// Escape HTML per sicurezza
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
