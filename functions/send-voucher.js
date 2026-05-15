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

// ── Verifica server-side dell'ordine PayPal ──────────────────────────
// Recupera l'access token e poi i dettagli dell'ordine. Restituisce true
// se l'ordine esiste ed è in stato COMPLETED, altrimenti false.
async function verifyPaypalOrder(orderId, env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_SECRET) {
    // Se le credenziali non sono configurate, NON blocchiamo il flusso (retrocompatibilità)
    // ma logghiamo un warning per dare visibilità.
    console.warn('PayPal credentials non configurate: verifica ordine saltata');
    return true;
  }
  try {
    const basic = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`);
    const tokenR = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!tokenR.ok) {
      console.error('PayPal token fail:', tokenR.status);
      return false;
    }
    const { access_token } = await tokenR.json();
    const orderR = await fetch(`${PAYPAL_API}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });
    if (!orderR.ok) {
      console.error('PayPal order fail:', orderR.status, orderId);
      return false;
    }
    const order = await orderR.json();
    return order && order.status === 'COMPLETED';
  } catch (err) {
    console.error('verifyPaypalOrder error:', err.message);
    return false;
  }
}

// ── Sanifica stringhe usate negli header (subject Reply-To)
//    Rimuove CR/LF per prevenire header injection
function sanHeader(s, maxLen = 200) {
  return String(s || '').replace(/[\r\n]+/g, ' ').slice(0, maxLen);
}

// ── Versione text/plain delle email (anti-spam, accessibilità)
function textAcquirente(d) {
  const persone = d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`;
  return [
    `Ciao ${d.nomeAcquirente},`,
    '',
    `Hai regalato un'esperienza all'L'800 Locanda a Palazzo.`,
    `In allegato trovi il Buono Regalo in formato PDF.`,
    '',
    `Riepilogo:`,
    `  Prodotto: ${d.prodotto}`,
    `  Valido per: ${persone}`,
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
  const persone = d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`;
  return [
    `Ciao ${d.nomeDestinatario},`,
    '',
    `${d.nomeAcquirente} ti ha fatto un regalo speciale: una cena all'L'800 Locanda a Palazzo,`,
    `nel cuore di Amantea, sulla costa tirrenica calabrese.`,
    '',
    d.messaggioPersonale ? `Il messaggio: "${d.messaggioPersonale}"\n` : '',
    `Il tuo Buono Regalo:`,
    `  ${d.prodotto}`,
    `  Valido per: ${persone}`,
    `  Codice: ${d.codiceVoucher}`,
    `  Scadenza: ${d.scadenza}`,
    '',
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
  const required = [
    'nomeAcquirente', 'emailAcquirente', 'nomeDestinatario',
    'prodotto', 'numPersone', 'codiceVoucher', 'scadenza',
    'paypalOrderId', 'pdfBase64',
  ];
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

  // 3c. Limite dimensione PDF (decoded). Stima rapida: base64 ≈ originale × 1.33
  const pdfBase64Raw = String(d.pdfBase64 || '');
  const approxBytes = Math.floor(pdfBase64Raw.length * 0.75);
  if (approxBytes > MAX_PDF_BYTES) {
    return jsonResponse({ error: 'PDF troppo grande' }, 413, cors);
  }

  // 4. Sanificazioni
  d.numPersone = parseInt(d.numPersone, 10) || 1;
  if (d.numPersone < 1 || d.numPersone > 200) d.numPersone = 1;

  // Rimuovi eventuale prefisso data URI (safety net — il browser lo fa già)
  const pdfContent = pdfBase64Raw.includes(',')
    ? pdfBase64Raw.split(',')[1]
    : pdfBase64Raw;

  // 4b. Verifica server-side dell'ordine PayPal (anti-frode)
  const paypalOk = await verifyPaypalOrder(d.paypalOrderId, env);
  if (!paypalOk) {
    return jsonResponse({ error: 'Ordine PayPal non valido o non completato' }, 402, cors);
  }

  // 5. Allegato Resend — nome file personalizzato con codice voucher
  const codiceSafe = String(d.codiceVoucher).replace(/[^A-Z0-9-]/gi, '');
  const attachment = [{
    filename: `buono-regalo-l800-${codiceSafe}.pdf`,
    content: pdfContent,
  }];

  // 6. Subject sanitizzato per prevenire header injection
  const subjAcq = sanHeader(`Il tuo Buono Regalo L'800 \u2714`);
  const subjDest = sanHeader(`${d.nomeAcquirente} ti ha fatto un regalo speciale \uD83C\uDF81`);
  const replyTo = 'info@l800.it';

  // 7. Email all'acquirente (await — bloccante)
  let r1;
  try {
    r1 = await fetch(RESEND_URL, {
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
        attachments: attachment,
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
          attachments: attachment,
        }),
      }).catch(err => console.error('Email destinatario error:', err.message))
    );
  }

  // 8b. Log strutturato vendita (consultabile da Cloudflare > Logs / Logpush)
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

  // 9. Risposta di successo
  return jsonResponse({ success: true }, 200, cors);
}

function htmlAcquirente(d) {
  const persone = d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`;
  const msgBlock = d.messaggioPersonale
    ? `<div style="border-left:3px solid #c4a882;padding:12px 18px;margin:24px 0;background:#f5efe4;">
         <div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:2px;color:#a67c52;text-transform:uppercase;margin-bottom:8px;">Il tuo messaggio</div>
         <p style="font-family:Georgia,serif;font-size:15px;font-style:italic;color:#7a5c3c;margin:0;line-height:1.75;">&ldquo;${esc(d.messaggioPersonale)}&rdquo;</p>
       </div>` : '';

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Il tuo Buono Regalo L'800</title></head>
<body style="margin:0;padding:0;background:#ede4d4;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:580px;margin:0 auto;">

  <div style="background:#5c3515;padding:40px 48px 32px;text-align:center;">
    <div style="font-size:40px;font-style:italic;color:#faf6ef;letter-spacing:1px;">L&rsquo;800</div>
    <div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:4px;color:#c4a882;text-transform:uppercase;margin-top:6px;">Locanda a Palazzo &middot; Amantea</div>
  </div>

  <div style="background:#faf6ef;padding:44px 48px 8px;">
    <p style="font-size:18px;color:#3d2810;margin:0 0 8px;">Ciao <strong>${esc(d.nomeAcquirente)}</strong>,</p>
    <p style="font-size:16px;font-style:italic;color:#7a5c3c;line-height:1.8;margin:0 0 24px;">
      hai regalato un&rsquo;esperienza che vale un ricordo.
    </p>
    <p style="font-size:15px;color:#7a5c3c;line-height:1.8;margin:0 0 28px;">
      In allegato trovi il <strong style="color:#3d2810;">Buono Regalo L&rsquo;800</strong> in formato PDF &mdash;
      pronto da stampare, inviare o consegnare a mano.<br>
      Per utilizzarlo basta prenotare un tavolo: pensiamo noi al resto.
    </p>

    ${msgBlock}

    <div style="background:#5c3515;padding:28px 32px;margin-bottom:28px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;letter-spacing:3px;color:#c4a882;text-transform:uppercase;margin-bottom:14px;">Riepilogo acquisto</div>
      <div style="font-family:Georgia,serif;font-size:17px;font-style:italic;color:#faf6ef;margin-bottom:4px;">${esc(d.prodotto)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1.5px;color:#c4a882;text-transform:uppercase;margin-bottom:18px;padding:8px 12px;background:rgba(255,255,255,0.08);">Valido per <strong style="color:#faf6ef;font-size:15px;">${persone}</strong></div>
      <div style="border-top:1px dashed rgba(196,168,130,0.3);padding-top:18px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;letter-spacing:2.5px;color:#c4a882;text-transform:uppercase;margin-bottom:8px;">Codice voucher</div>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:bold;color:#faf6ef;letter-spacing:3px;">${d.codiceVoucher}</div>
        <div style="font-family:Georgia,serif;font-size:11px;font-style:italic;color:rgba(245,239,228,0.5);margin-top:8px;">Valido fino al ${d.scadenza}</div>
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
      <tr><td style="padding:9px 0;border-bottom:1px solid rgba(122,78,40,0.1);font-size:13px;color:#a67c52;width:38%;">Destinatario</td>
          <td style="padding:9px 0;border-bottom:1px solid rgba(122,78,40,0.1);font-size:14px;font-weight:bold;color:#3d2810;">${esc(d.nomeDestinatario)}</td></tr>
      <tr><td style="padding:9px 0;font-size:13px;color:#a67c52;">ID transazione</td>
          <td style="padding:9px 0;font-size:11px;color:#a67c52;font-family:monospace;">${d.paypalOrderId}</td></tr>
    </table>

    <div style="background:#ede4d4;padding:20px 24px;margin-bottom:28px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:2px;color:#a67c52;text-transform:uppercase;margin-bottom:10px;">Come utilizzare il buono</div>
      <p style="font-size:14px;color:#7a5c3c;line-height:1.7;margin:0 0 10px;">
        Per prenotare, il destinatario pu&ograve; scriverci su WhatsApp, chiamarci al 0982 428262 o prenotare direttamente online tramite Octotable. Al momento di presentarsi al ristorante, sar&agrave; sufficiente comunicare il codice voucher.
      </p>
      <p style="font-size:14px;color:#7a5c3c;line-height:1.7;margin:0;">
        Il buono &egrave; valido per ${persone} per 12 mesi dall&rsquo;acquisto.
      </p>
    </div>

    <p style="font-size:14px;color:#7a5c3c;line-height:1.8;margin:0 0 12px;">${
      d.emailDestinatario && d.emailDestinatario.includes('@') && d.emailDestinatario.trim().toLowerCase() !== d.emailAcquirente.trim().toLowerCase()
        ? 'Abbiamo gi&agrave; inviato una copia del buono a <strong style="color:#3d2810;">' + esc(d.emailDestinatario) + '</strong>. Puoi comunque condividere anche il PDF allegato a questa email.'
        : 'Condividi il PDF allegato a questa email con il destinatario per consegnargli il buono.'
    }</p>
    <p style="font-size:14px;color:#7a5c3c;line-height:1.8;margin:0 0 12px;">Per prenotare, il destinatario pu&ograve; contattarci tramite:</p>
    <table style="border-collapse:collapse;margin-bottom:16px;">
      <tr>
        <td style="padding-right:12px;"><a href="https://wa.me/390982428262" style="display:inline-block;background:#2e7d32;color:#fff;font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;padding:11px 22px;text-decoration:none;">WhatsApp</a></td>
        <td><a href="https://octotable.com/book/restaurant/561331/booking/home" style="display:inline-block;border:1px solid #7a4e28;color:#7a4e28;font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;padding:11px 22px;text-decoration:none;">Octotable</a></td>
      </tr>
    </table>
    <p style="font-size:13px;color:#a67c52;margin:0 0 36px;">oppure chiama il <a href="tel:+390982428262" style="color:#7a4e28;">0982 428262</a></p>
  </div>

  <div style="background:#faf6ef;padding:0 48px 36px;">
    <div style="border-top:1px solid rgba(122,78,40,0.12);padding-top:24px;">
      <div style="font-size:20px;font-style:italic;color:#7a4e28;">L&rsquo;800</div>
      <div style="font-family:Helvetica,sans-serif;font-size:8px;letter-spacing:2px;color:#a67c52;text-transform:uppercase;margin-top:3px;">Locanda a Palazzo</div>
      <p style="font-size:12px;color:#a67c52;margin:8px 0 0;line-height:1.6;">
        Via Calavecchia 53 &middot; 87032 Amantea (CS)<br>
        <a href="tel:+390982428262" style="color:#7a4e28;">+39 0982 428262</a> &middot;
        <a href="mailto:info@l800.it" style="color:#7a4e28;">info@l800.it</a> &middot;
        <a href="https://www.l800.it" style="color:#7a4e28;">www.l800.it</a>
      </p>
    </div>
  </div>

  <div style="background:#7a4e28;padding:16px 48px;text-align:center;">
    <p style="font-family:Helvetica,sans-serif;font-size:9px;color:rgba(245,239,228,0.5);margin:0;letter-spacing:1px;">Il mare, il palazzo, la Calabria.</p>
  </div>

</div></body></html>`;
}

// =============================================================================
// TEMPLATE EMAIL DESTINATARIO
// Tono: sorpresa ed emozione. Introduce L'800 a chi (forse) non lo conosce.
// =============================================================================
function htmlDestinatario(d) {
  const persone = d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`;
  const msgBlock = d.messaggioPersonale
    ? `<div style="border-left:3px solid #c4a882;padding:14px 20px;margin:24px 0;background:#f5efe4;">
         <p style="font-family:Georgia,serif;font-size:17px;font-style:italic;color:#7a5c3c;margin:0 0 10px;line-height:1.75;">&ldquo;${esc(d.messaggioPersonale)}&rdquo;</p>
         <div style="font-size:13px;font-style:italic;color:#a67c52;">&mdash; ${esc(d.nomeAcquirente)}</div>
       </div>`
    : `<p style="font-size:15px;font-style:italic;color:#7a5c3c;line-height:1.8;margin:0 0 24px;">Con affetto, da <strong style="color:#3d2810;">${esc(d.nomeAcquirente)}</strong>.</p>`;

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Un regalo per te &mdash; L'800</title></head>
<body style="margin:0;padding:0;background:#ede4d4;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:580px;margin:0 auto;">

  <div style="background:#5c3515;padding:40px 48px 32px;text-align:center;">
    <div style="font-size:40px;font-style:italic;color:#faf6ef;letter-spacing:1px;">L&rsquo;800</div>
    <div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;letter-spacing:4px;color:#c4a882;text-transform:uppercase;margin-top:6px;">Locanda a Palazzo &middot; Amantea</div>
  </div>

  <div style="background:#faf6ef;padding:44px 48px 8px;">
    <p style="font-size:18px;color:#3d2810;margin:0 0 8px;">Ciao <strong>${esc(d.nomeDestinatario)}</strong>,</p>
    <p style="font-size:16px;font-style:italic;color:#7a5c3c;line-height:1.8;margin:0 0 20px;">
      <strong style="color:#3d2810;">${esc(d.nomeAcquirente)}</strong> ti ha fatto un regalo che vale una serata.
    </p>

    ${msgBlock}

    <div style="background:#ede4d4;padding:22px 24px;margin:0 0 28px;">
      <p style="font-size:14px;color:#7a5c3c;line-height:1.8;margin:0;">
        Ti aspetta una cena all&rsquo;<strong>L&rsquo;800 Locanda a Palazzo</strong> &mdash;
        un palazzo dell&rsquo;Ottocento nel centro storico di Amantea, sulla costa tirrenica calabrese.
        Il pescato fresco del Tirreno, un giardino in cui il tempo rallenta, e l&rsquo;eleganza discreta
        di chi sa che ogni dettaglio conta.
      </p>
    </div>

    <div style="background:#5c3515;padding:28px 32px;margin-bottom:28px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;letter-spacing:3px;color:#c4a882;text-transform:uppercase;margin-bottom:14px;">Il tuo Buono Regalo</div>
      <div style="font-family:Georgia,serif;font-size:18px;font-style:italic;color:#faf6ef;margin-bottom:4px;">${esc(d.prodotto)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1.5px;color:#c4a882;text-transform:uppercase;margin-bottom:18px;padding:8px 12px;background:rgba(255,255,255,0.08);">Valido per <strong style="color:#faf6ef;font-size:15px;">${persone}</strong></div>
      <div style="border-top:1px dashed rgba(196,168,130,0.3);padding-top:18px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;letter-spacing:2.5px;color:#c4a882;text-transform:uppercase;margin-bottom:8px;">Codice voucher</div>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:bold;color:#faf6ef;letter-spacing:3px;">${d.codiceVoucher}</div>
        <div style="font-family:Georgia,serif;font-size:11px;font-style:italic;color:rgba(245,239,228,0.5);margin-top:8px;">Valido fino al ${d.scadenza}</div>
      </div>
    </div>

    <p style="font-size:14px;color:#7a5c3c;line-height:1.8;margin:0 0 18px;">
      Presenta il codice al momento del pagamento.
    </p>

    <!-- CTA PRINCIPALE -->
    <div style="text-align:center;margin:0 0 24px;">
      <a href="https://wa.me/390982428262?text=Ciao%2C%20vorrei%20prenotare%20usando%20il%20buono%20regalo%20${encodeURIComponent(d.codiceVoucher)}" style="display:inline-block;background:#2e7d32;color:#fff;font-family:Helvetica,Arial,sans-serif;font-size:14px;letter-spacing:1.8px;text-transform:uppercase;padding:16px 36px;text-decoration:none;font-weight:bold;">Prenota il tuo tavolo →</a>
    </div>

    <p style="text-align:center;font-size:12px;color:#a67c52;margin:0 0 16px;">oppure</p>

    <table style="border-collapse:collapse;margin-bottom:16px;width:100%;">
      <tr>
        <td style="padding-right:8px;width:50%;"><a href="https://octotable.com/book/restaurant/561331/booking/home" style="display:block;text-align:center;border:1px solid #7a4e28;color:#7a4e28;font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;padding:11px 18px;text-decoration:none;">Prenota su Octotable</a></td>
        <td style="padding-left:8px;width:50%;"><a href="tel:+390982428262" style="display:block;text-align:center;border:1px solid #7a4e28;color:#7a4e28;font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;padding:11px 18px;text-decoration:none;">Chiama</a></td>
      </tr>
    </table>
    <p style="font-size:13px;color:#a67c52;margin:0 0 36px;">oppure chiama il <a href="tel:+390982428262" style="color:#7a4e28;">0982 428262</a></p>
  </div>

  <div style="background:#faf6ef;padding:0 48px 36px;">
    <div style="border-top:1px solid rgba(122,78,40,0.12);padding-top:24px;">
      <div style="font-size:20px;font-style:italic;color:#7a4e28;">L&rsquo;800</div>
      <div style="font-family:Helvetica,sans-serif;font-size:8px;letter-spacing:2px;color:#a67c52;text-transform:uppercase;margin-top:3px;">Locanda a Palazzo</div>
      <p style="font-size:12px;color:#a67c52;margin:8px 0 0;line-height:1.6;">
        Via Calavecchia 53 &middot; 87032 Amantea (CS)<br>
        <a href="tel:+390982428262" style="color:#7a4e28;">+39 0982 428262</a> &middot;
        <a href="mailto:info@l800.it" style="color:#7a4e28;">info@l800.it</a> &middot;
        <a href="https://www.l800.it" style="color:#7a4e28;">www.l800.it</a>
      </p>
    </div>
  </div>

  <div style="background:#7a4e28;padding:16px 48px;text-align:center;">
    <p style="font-family:Helvetica,sans-serif;font-size:9px;color:rgba(245,239,228,0.5);margin:0;letter-spacing:1px;">Il mare, il palazzo, la Calabria.</p>
  </div>

</div></body></html>`;
}

// Escape HTML per sicurezza
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
