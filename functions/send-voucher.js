// Cloudflare Pages Function: send-voucher
// File: functions/send-voucher.js  →  Endpoint: POST /send-voucher
// Runtime: Cloudflare Workers (V8) — fetch nativo, niente Node.js
// Env var: RESEND_API_KEY (Pages > Settings > Environment variables)

const RESEND_URL = 'https://api.resend.com/emails';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Preflight CORS ──────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

// ── POST /send-voucher ──────────────────────────────────────────────
// context contiene: { request, env, waitUntil, params, data, next }
export async function onRequestPost({ request, env, waitUntil }) {

  // 1. API key Resend
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY mancante nelle variabili d\'ambiente');
    return jsonResponse({ error: 'Configurazione server mancante' }, 500);
  }

  // 2. Parsa il body JSON
  let d;
  try {
    d = await request.json();
  } catch {
    return jsonResponse({ error: 'Body JSON non valido' }, 400);
  }

  // 3. Valida i campi obbligatori
  const required = [
    'nomeAcquirente', 'emailAcquirente', 'nomeDestinatario',
    'prodotto', 'numPersone', 'codiceVoucher', 'scadenza',
    'paypalOrderId', 'pdfBase64',
  ];
  for (const field of required) {
    if (!d[field] && d[field] !== 0) {
      return jsonResponse({ error: `Campo obbligatorio mancante: ${field}` }, 400);
    }
  }

  // 4. Sanificazioni
  d.numPersone = parseInt(d.numPersone, 10) || 1;
  // Rimuovi eventuale prefisso data URI (safety net — il browser lo fa già)
  const pdfContent = d.pdfBase64.includes(',')
    ? d.pdfBase64.split(',')[1]
    : d.pdfBase64;

  // 5. Struttura allegato Resend — content deve essere base64 puro
  const attachment = [{
    filename: 'buono-regalo-l800.pdf',
    content: pdfContent,
  }];

  // 6. Email all'acquirente (await — bloccante, serve conferma)
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
        subject: `Il tuo Buono Regalo L'800 \u2714`,
        html: htmlAcquirente(d),
        attachments: attachment,
      }),
    });
  } catch (err) {
    console.error('Fetch Resend (acquirente) error:', err.message);
    return jsonResponse({ error: 'Errore di rete: ' + err.message }, 502);
  }

  if (!r1.ok) {
    const errText = await r1.text();
    console.error('Resend API error (acquirente):', r1.status, errText);
    return jsonResponse({ error: 'Invio email fallito', detail: errText }, 500);
  }

  // 7. Email al destinatario — in background con waitUntil
  //    (pendingPromises vengono cancellate se la Response è già restituita
  //     senza waitUntil — confermato dalla documentazione Cloudflare)
  const emailDestValida =
    d.emailDestinatario &&
    d.emailDestinatario.includes('@') &&
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
          subject: `${d.nomeAcquirente} ti ha fatto un regalo speciale \uD83C\uDF81`,
          html: htmlDestinatario(d),
          attachments: attachment,
        }),
      }).catch(err => console.error('Email destinatario error:', err.message))
    );
  }

  // 8. Risposta di successo
  return jsonResponse({ success: true });
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

    <p style="font-size:14px;color:#7a5c3c;line-height:1.8;margin:0 0 12px;">
      Presenta il codice al momento del pagamento. Per prenotare il tuo tavolo:
    </p>
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

// Escape HTML per sicurezza
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
