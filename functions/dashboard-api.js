// Cloudflare Pages Function: dashboard-api
// Endpoint: POST /dashboard-api
// Env vars: DASHBOARD_PASSWORD, RESEND_API_KEY, VOUCHERS (KV namespace)

const RESEND_URL = 'https://api.resend.com/emails';
const PREZZI = { 3: 50, 4: 65 };
const ALLOWED_ORIGINS = ['https://www.l800.it', 'https://l800.it'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Password',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonWithOrigin(data, status = 200, origin = ALLOWED_ORIGINS[0]) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function cors(origin) {
  return new Response(null, { status: 200, headers: corsHeaders(origin) });
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generaCodice(tipo, numPortate) {
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  const ts   = Date.now().toString(36).slice(-3).toUpperCase();
  if (tipo === 'libero') return `L800-LIB-${rand}${ts}`;
  return `L800-${numPortate}P-${rand}${ts}`;
}

function checkAuth(request, env) {
  const pwd = request.headers.get('X-Dashboard-Password');
  if (!env.DASHBOARD_PASSWORD) return false; // non configurata → nega tutto
  return pwd === env.DASHBOARD_PASSWORD;
}

// ── KV helpers ───────────────────────────────────────────────────────────────

async function listVouchers(env) {
  const list = await env.VOUCHERS.list({ prefix: 'voucher:' });
  const keys = list.keys.map(k => k.name);
  const records = await Promise.all(
    keys.map(k => env.VOUCHERS.get(k).then(v => v ? JSON.parse(v) : null))
  );
  return records
    .filter(Boolean)
    .sort((a, b) => (b.dataAcquisto || '').localeCompare(a.dataAcquisto || ''));
}

async function getVoucher(env, codice) {
  const raw = await env.VOUCHERS.get(`voucher:${codice}`);
  return raw ? JSON.parse(raw) : null;
}

async function putVoucher(env, record) {
  await env.VOUCHERS.put(`voucher:${record.codice}`, JSON.stringify(record));
}

async function listNewsletter(env) {
  const list = await env.VOUCHERS.list({ prefix: 'newsletter:' });
  const keys = list.keys.map(k => k.name);
  const records = await Promise.all(
    keys.map(k => env.VOUCHERS.get(k).then(v => v ? JSON.parse(v) : null))
  );
  return records
    .filter(Boolean)
    .sort((a, b) => (b.data || '').localeCompare(a.data || ''));
}

async function deleteNewsletter(env, email) {
  const key = `newsletter:${String(email || '').trim().toLowerCase()}`;
  await env.VOUCHERS.delete(key);
}

// ── Email templates (semplificati ma completi) ───────────────────────────────

function buildSubjectAcquirente(d) {
  return `Il tuo Buono Regalo L'800 – ${d.codice}`;
}
function buildSubjectDestinatario(d) {
  return `Un regalo per te – L'800 Locanda a Palazzo`;
}

function htmlEmailAcquirente(d) {
  const isLibero = d.tipo === 'libero';
  const persone  = !isLibero ? (d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`) : null;
  const validita = isLibero
    ? `Buono del valore di <strong style="color:#fbf7ef;">&euro; ${d.importoLibero}</strong>`
    : `Valido per <strong style="color:#fbf7ef;">${persone}</strong>`;
  const frase = isLibero
    ? `del valore di &euro; ${d.importoLibero}, da scalare sul conto,`
    : `valido per ${persone}`;

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#ecd9b6;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:580px;margin:0 auto;">
  <div style="background:#4a2612;padding:40px 48px 32px;text-align:center;">
    <div style="font-size:40px;font-style:italic;color:#fbf7ef;">L&rsquo;800</div>
    <div style="font-family:Helvetica,sans-serif;font-size:8px;letter-spacing:4px;color:#d9b988;text-transform:uppercase;margin-top:6px;">Locanda a Palazzo &middot; Amantea</div>
  </div>
  <div style="background:#fbf7ef;padding:44px 48px;">
    <p style="font-size:18px;color:#2a1a10;margin:0 0 8px;">Ciao <strong>${esc(d.nomeAcquirente)}</strong>,</p>
    <p style="font-size:15px;color:#807068;margin:0 0 24px;">Il tuo Buono Regalo è stato ${d.origine === 'cassa' ? 'creato' : 'acquistato'} con successo. In allegato trovi il PDF da consegnare al destinatario.</p>
    <div style="background:#4a2612;padding:24px 28px;margin-bottom:24px;">
      <div style="font-size:7px;letter-spacing:3px;color:#d9b988;text-transform:uppercase;font-family:Helvetica,sans-serif;margin-bottom:12px;">Riepilogo</div>
      <div style="font-size:15px;font-style:italic;color:#fbf7ef;margin-bottom:6px;">${esc(d.prodotto)}</div>
      <div style="font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#d9b988;padding:6px 10px;background:rgba(255,255,255,0.08);margin-bottom:14px;">${validita}</div>
      <div style="border-top:1px dashed rgba(217,185,136,0.3);padding-top:14px;">
        <div style="font-size:7px;letter-spacing:2px;color:#d9b988;text-transform:uppercase;font-family:Helvetica,sans-serif;">Codice voucher</div>
        <div style="font-size:20px;font-weight:bold;color:#fbf7ef;letter-spacing:3px;font-family:Helvetica,sans-serif;margin-top:6px;">${esc(d.codice)}</div>
        <div style="font-size:11px;font-style:italic;color:rgba(251,247,239,0.5);margin-top:6px;">Valido fino al ${esc(d.scadenza)}</div>
      </div>
    </div>
    <p style="font-size:13px;color:#807068;margin:0 0 8px;">Il buono è ${frase} per 12 mesi dall'acquisto.</p>
    <p style="font-size:13px;color:#807068;margin:0;">Destinatario: <strong>${esc(d.nomeDestinatario)}</strong></p>
  </div>
  <div style="background:#6f3b1c;padding:16px 48px;text-align:center;">
    <p style="font-size:9px;color:rgba(251,247,239,0.5);margin:0;letter-spacing:1px;font-family:Helvetica,sans-serif;">Il mare, il palazzo, la Calabria.</p>
  </div>
</div></body></html>`;
}

function htmlEmailDestinatario(d) {
  const isLibero = d.tipo === 'libero';
  const persone  = !isLibero ? (d.numPersone === 1 ? '1 persona' : `${d.numPersone} persone`) : null;
  const prodotto = isLibero ? 'Buono Regalo' : esc(d.prodotto);
  const validita = isLibero
    ? `un valore di <strong style="color:#fbf7ef;">&euro; ${d.importoLibero}</strong>`
    : `Valido per <strong style="color:#fbf7ef;">${persone}</strong>`;
  const usoFrase = isLibero ? 'Potrai utilizzarlo sul conto della tua cena, scegliendo liberamente dal nostro menu. ' : '';
  const msg = d.messaggioPersonale
    ? `<div style="border-left:3px solid #d9b988;padding:14px 20px;margin:20px 0;background:#fbf7ef;">
         <p style="font-size:17px;font-style:italic;color:#807068;margin:0;">&ldquo;${esc(d.messaggioPersonale)}&rdquo;</p>
         <div style="font-size:13px;font-style:italic;color:#8a5630;margin-top:8px;">&mdash; ${esc(d.nomeAcquirente)}</div>
       </div>`
    : `<p style="font-size:15px;font-style:italic;color:#807068;margin:0 0 20px;">Con affetto, da <strong>${esc(d.nomeAcquirente)}</strong>.</p>`;

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#ecd9b6;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:580px;margin:0 auto;">
  <div style="background:#4a2612;padding:40px 48px 32px;text-align:center;">
    <div style="font-size:40px;font-style:italic;color:#fbf7ef;">L&rsquo;800</div>
    <div style="font-family:Helvetica,sans-serif;font-size:8px;letter-spacing:4px;color:#d9b988;text-transform:uppercase;margin-top:6px;">Locanda a Palazzo &middot; Amantea</div>
  </div>
  <div style="background:#fbf7ef;padding:44px 48px 8px;">
    <p style="font-size:18px;color:#2a1a10;margin:0 0 8px;">Ciao <strong>${esc(d.nomeDestinatario)}</strong>,</p>
    <p style="font-size:15px;font-style:italic;color:#807068;margin:0 0 16px;"><strong style="color:#2a1a10;">${esc(d.nomeAcquirente)}</strong> ti ha fatto un regalo che vale una serata.</p>
    ${msg}
    <div style="background:#ecd9b6;padding:18px 20px;margin:0 0 24px;">
      <p style="font-size:14px;color:#807068;margin:0;">Ti aspetta una cena all&rsquo;<strong>L&rsquo;800 Locanda a Palazzo</strong> &mdash; un palazzo dell&rsquo;Ottocento nel centro storico di Amantea, sulla costa tirrenica calabrese.</p>
    </div>
    <div style="background:#4a2612;padding:24px 28px;margin-bottom:24px;">
      <div style="font-size:7px;letter-spacing:3px;color:#d9b988;text-transform:uppercase;font-family:Helvetica,sans-serif;margin-bottom:12px;">Il tuo Buono Regalo</div>
      <div style="font-size:17px;font-style:italic;color:#fbf7ef;margin-bottom:4px;">${prodotto}</div>
      <div style="font-family:Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#d9b988;padding:6px 10px;background:rgba(255,255,255,0.08);margin-bottom:14px;">${validita}</div>
      <div style="border-top:1px dashed rgba(217,185,136,0.3);padding-top:14px;">
        <div style="font-size:7px;letter-spacing:2px;color:#d9b988;text-transform:uppercase;font-family:Helvetica,sans-serif;">Codice voucher</div>
        <div style="font-size:20px;font-weight:bold;color:#fbf7ef;letter-spacing:3px;font-family:Helvetica,sans-serif;margin-top:6px;">${esc(d.codice)}</div>
        <div style="font-size:11px;font-style:italic;color:rgba(251,247,239,0.5);margin-top:6px;">Valido fino al ${esc(d.scadenza)}</div>
      </div>
    </div>
    <p style="font-size:14px;color:#807068;margin:0 0 20px;">${usoFrase}Presenta il codice al momento del pagamento.</p>
    <div style="text-align:center;margin:0 0 20px;">
      <a href="https://wa.me/390982428262?text=Ciao%2C%20vorrei%20prenotare%20usando%20il%20buono%20${encodeURIComponent(d.codice)}" style="display:inline-block;background:#2e7d32;color:#fff;font-family:Helvetica,sans-serif;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;padding:14px 32px;text-decoration:none;font-weight:bold;">Prenota il tuo tavolo →</a>
    </div>
    <p style="font-size:12px;color:#8a5630;text-align:center;margin:0 0 32px;">oppure chiama il <a href="tel:+390982428262" style="color:#6f3b1c;">0982 428262</a></p>
  </div>
  <div style="background:#6f3b1c;padding:16px 48px;text-align:center;">
    <p style="font-size:9px;color:rgba(251,247,239,0.5);margin:0;letter-spacing:1px;font-family:Helvetica,sans-serif;">Il mare, il palazzo, la Calabria.</p>
  </div>
</div></body></html>`;
}

async function sendEmails(env, record, pdfBase64) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return;

  const attachment = pdfBase64 ? [{
    filename: `Buono-Regalo-L800-${record.codice}.pdf`,
    content:  pdfBase64,
  }] : [];

  const promises = [];

  if (record.emailAcquirente) {
    promises.push(
      fetch(RESEND_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: "L'800 Locanda a Palazzo <info@l800.it>",
          to:   [record.emailAcquirente],
          subject: buildSubjectAcquirente(record),
          html: htmlEmailAcquirente(record),
          text: `Il tuo Buono Regalo L'800 – ${record.codice}\nDestinatario: ${record.nomeDestinatario}\nScadenza: ${record.scadenza}`,
          attachments: attachment,
        }),
      }).catch(err => console.error('Email acquirente error:', err.message))
    );
  }

  if (record.emailDestinatario) {
    promises.push(
      fetch(RESEND_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: "L'800 Locanda a Palazzo <info@l800.it>",
          to:   [record.emailDestinatario],
          subject: buildSubjectDestinatario(record),
          html: htmlEmailDestinatario(record),
          text: `${record.nomeAcquirente} ti ha fatto un regalo – Buono L'800 ${record.codice}, valido fino al ${record.scadenza}.`,
          attachments: attachment,
        }),
      }).catch(err => console.error('Email destinatario error:', err.message))
    );
  }

  await Promise.allSettled(promises);
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function onRequestOptions({ request }) {
  return cors(request.headers.get('Origin'));
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  const json = (data, status = 200) => jsonWithOrigin(data, status, origin);

  if (!checkAuth(request, env)) return json({ error: 'Non autorizzato' }, 401);
  if (!env.VOUCHERS) return json({ error: 'KV non configurato' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'JSON non valido' }, 400); }

  const { action } = body;

  // ── LIST ────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const vouchers = await listVouchers(env);
    return json({ ok: true, vouchers });
  }

  // ── NEWSLETTER LIST ───────────────────────────────────────────────────────
  if (action === 'newsletter-list') {
    const subscribers = await listNewsletter(env);
    return json({ ok: true, subscribers });
  }

  // ── NEWSLETTER DELETE (disiscrizione manuale) ────────────────────────────
  if (action === 'newsletter-delete') {
    if (!body.email) return json({ error: 'Email mancante' }, 400);
    await deleteNewsletter(env, body.email);
    return json({ ok: true });
  }

  // ── GET ─────────────────────────────────────────────────────────────────
  if (action === 'get') {
    const v = await getVoucher(env, body.codice);
    if (!v) return json({ error: 'Buono non trovato' }, 404);
    return json({ ok: true, voucher: v });
  }

  // ── MARK-USED ────────────────────────────────────────────────────────────
  if (action === 'mark-used') {
    const v = await getVoucher(env, body.codice);
    if (!v) return json({ error: 'Buono non trovato' }, 404);
    v.stato        = 'utilizzato';
    v.dataUtilizzo = new Date().toISOString().split('T')[0];
    await putVoucher(env, v);
    return json({ ok: true, voucher: v });
  }

  // ── CREATE (manuale, origine: cassa) ─────────────────────────────────────
  if (action === 'create') {
    const { tipo, numPortate, numPersone, importoLibero,
            importoPagato, nomeAcquirente, emailAcquirente,
            nomeDestinatario, emailDestinatario, messaggioPersonale,
            scadenza, pdfBase64 } = body;

    if (!nomeAcquirente || !nomeDestinatario) {
      return json({ error: 'Nome acquirente e destinatario obbligatori' }, 400);
    }
    if (!tipo || !['fisso', 'libero'].includes(tipo)) {
      return json({ error: 'Tipo non valido' }, 400);
    }
    if (tipo === 'fisso' && ![3, 4].includes(parseInt(numPortate))) {
      return json({ error: 'numPortate deve essere 3 o 4' }, 400);
    }
    if (tipo === 'libero') {
      const imp = parseInt(importoLibero, 10);
      if (!Number.isInteger(imp) || imp < 25) {
        return json({ error: 'Importo libero minimo €25' }, 400);
      }
    }

    const np     = parseInt(numPersone, 10) || 1;
    const porto  = parseInt(numPortate, 10) || 3;
    const impLib = parseInt(importoLibero, 10) || 0;
    const impPag = parseFloat(importoPagato) || 0;
    const codice = generaCodice(tipo, porto);

    // Calcola scadenza default (12 mesi da oggi)
    let scadenzaStr = scadenza;
    if (!scadenzaStr) {
      const d = new Date();
      d.setFullYear(d.getFullYear() + 1);
      scadenzaStr = d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    const prodotto = tipo === 'libero'
      ? `Buono regalo – Importo libero (€${impLib})`
      : `Buono regalo – ${porto} Portate × ${np}`;

    const record = {
      codice,
      tipo,
      numPortate:         tipo === 'fisso' ? porto : null,
      numPersone:         tipo === 'fisso' ? np    : null,
      importoLibero:      tipo === 'libero' ? impLib : 0,
      importoPagato:      impPag,
      origine:            'cassa',
      nomeAcquirente:     String(nomeAcquirente).trim(),
      emailAcquirente:    emailAcquirente ? String(emailAcquirente).trim() : '',
      nomeDestinatario:   String(nomeDestinatario).trim(),
      emailDestinatario:  emailDestinatario ? String(emailDestinatario).trim() : '',
      messaggioPersonale: messaggioPersonale ? String(messaggioPersonale).trim() : '',
      prodotto,
      dataAcquisto:       new Date().toISOString().split('T')[0],
      scadenza:           scadenzaStr,
      stato:              'attivo',
      dataUtilizzo:       null,
      paypalOrderId:      null,
    };

    await putVoucher(env, record);
    await sendEmails(env, record, pdfBase64 || null);

    return json({ ok: true, voucher: record });
  }

  return json({ error: 'Azione non riconosciuta' }, 400);
}
