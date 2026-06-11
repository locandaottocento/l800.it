// Cloudflare Pages Function: richiesta-evento
// Endpoint: POST /richiesta-evento
// Riceve richieste preventivo eventi e le invia via Resend a info@l800.it
// + email di conferma al richiedente

const RESEND_URL = 'https://api.resend.com/emails';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'JSON non valido' }, 400); }

  const { tipoEvento, dataEvento, numOspiti, nome, contatto, messaggio, lang } = body;

  // Validazione minima
  if (!tipoEvento || !nome || !contatto) {
    return json({ error: 'Campi obbligatori mancanti' }, 400);
  }
  if (String(nome).length > 100 || String(contatto).length > 100 || String(messaggio || '').length > 2000) {
    return json({ error: 'Dati troppo lunghi' }, 400);
  }

  // Honeypot anti-spam (campo nascosto che i bot compilano)
  if (body.website) {
    return json({ ok: true }); // finta accettazione, niente email
  }

  const isEn = lang === 'en';
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return json({ error: 'Configurazione email mancante' }, 500);

  const dataStr = dataEvento ? esc(dataEvento) : (isEn ? 'To be defined' : 'Da definire');
  const ospitiStr = numOspiti ? esc(String(numOspiti)) : (isEn ? 'Not specified' : 'Non specificato');

  // ── Email interna a info@l800.it ──
  const htmlInterna = `<!DOCTYPE html><html><body style="font-family:Georgia,serif;color:#2a1a10;max-width:560px;margin:0 auto;padding:24px;">
<h2 style="color:#6f3b1c;border-bottom:2px solid #d9b988;padding-bottom:8px;">Nuova richiesta evento dal sito</h2>
<table style="width:100%;border-collapse:collapse;font-size:15px;">
  <tr><td style="padding:8px 0;color:#8a5630;width:140px;">Tipo evento</td><td style="padding:8px 0;"><strong>${esc(tipoEvento)}</strong></td></tr>
  <tr><td style="padding:8px 0;color:#8a5630;">Data desiderata</td><td style="padding:8px 0;">${dataStr}</td></tr>
  <tr><td style="padding:8px 0;color:#8a5630;">Numero ospiti</td><td style="padding:8px 0;">${ospitiStr}</td></tr>
  <tr><td style="padding:8px 0;color:#8a5630;">Nome</td><td style="padding:8px 0;"><strong>${esc(nome)}</strong></td></tr>
  <tr><td style="padding:8px 0;color:#8a5630;">Contatto</td><td style="padding:8px 0;"><strong>${esc(contatto)}</strong></td></tr>
</table>
${messaggio ? `<div style="margin-top:16px;padding:14px 18px;background:#fbf7ef;border-left:3px solid #d9b988;"><div style="font-size:11px;color:#8a5630;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Messaggio</div><p style="margin:0;font-style:italic;">${esc(messaggio)}</p></div>` : ''}
<p style="margin-top:24px;font-size:12px;color:#8a5630;">Richiesta inviata dal form eventi di l800.it ${isEn ? '(versione inglese)' : ''}</p>
</body></html>`;

  // ── Email di conferma al richiedente (solo se contatto è un'email) ──
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contatto).trim());

  const htmlConferma = isEn
    ? `<!DOCTYPE html><html><body style="font-family:Georgia,serif;color:#2a1a10;max-width:560px;margin:0 auto;padding:24px;">
<div style="text-align:center;padding:24px;background:#4a2612;"><div style="font-size:36px;font-style:italic;color:#fbf7ef;">L&rsquo;800</div><div style="font-size:8px;letter-spacing:4px;color:#d9b988;text-transform:uppercase;margin-top:4px;">Locanda a Palazzo &middot; Amantea</div></div>
<div style="padding:32px 8px;">
<p style="font-size:17px;">Dear <strong>${esc(nome)}</strong>,</p>
<p style="font-size:15px;color:#5e5046;line-height:1.6;">Thank you for your enquiry about organising your <strong>${esc(tipoEvento)}</strong> at L'800. We have received your request and will get back to you <strong>within 24 hours</strong> with a tailored proposal.</p>
<p style="font-size:15px;color:#5e5046;line-height:1.6;">If you'd like to speak with us sooner, you can reach us on WhatsApp at <a href="https://wa.me/390982428262" style="color:#6f3b1c;">+39 0982 428262</a>.</p>
<p style="font-size:15px;color:#5e5046;">We look forward to hosting your special day.</p>
<p style="font-size:15px;font-style:italic;color:#8a5630;">The L'800 family</p>
</div></body></html>`
    : `<!DOCTYPE html><html><body style="font-family:Georgia,serif;color:#2a1a10;max-width:560px;margin:0 auto;padding:24px;">
<div style="text-align:center;padding:24px;background:#4a2612;"><div style="font-size:36px;font-style:italic;color:#fbf7ef;">L&rsquo;800</div><div style="font-size:8px;letter-spacing:4px;color:#d9b988;text-transform:uppercase;margin-top:4px;">Locanda a Palazzo &middot; Amantea</div></div>
<div style="padding:32px 8px;">
<p style="font-size:17px;">Gentile <strong>${esc(nome)}</strong>,</p>
<p style="font-size:15px;color:#5e5046;line-height:1.6;">grazie per averci scritto per il tuo <strong>${esc(tipoEvento)}</strong>. Abbiamo ricevuto la tua richiesta e ti risponderemo <strong>entro 24 ore</strong> con una proposta su misura.</p>
<p style="font-size:15px;color:#5e5046;line-height:1.6;">Se preferisci parlarci subito, ci trovi su WhatsApp al <a href="https://wa.me/390982428262" style="color:#6f3b1c;">+39 0982 428262</a>.</p>
<p style="font-size:15px;color:#5e5046;">Non vediamo l'ora di rendere speciale la tua occasione.</p>
<p style="font-size:15px;font-style:italic;color:#8a5630;">La famiglia dell'L'800</p>
</div></body></html>`;

  const emails = [
    fetch(RESEND_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: "Sito L'800 <info@l800.it>",
        to: ['info@l800.it'],
        reply_to: isEmail ? [String(contatto).trim()] : undefined,
        subject: `Richiesta evento: ${tipoEvento} — ${nome}`,
        html: htmlInterna,
        text: `Nuova richiesta evento\nTipo: ${tipoEvento}\nData: ${dataStr}\nOspiti: ${ospitiStr}\nNome: ${nome}\nContatto: ${contatto}\nMessaggio: ${messaggio || '-'}`,
      }),
    }),
  ];

  if (isEmail) {
    emails.push(
      fetch(RESEND_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: "L'800 Locanda a Palazzo <info@l800.it>",
          to: [String(contatto).trim()],
          subject: isEn
            ? `We received your request — L'800 Locanda a Palazzo`
            : `Abbiamo ricevuto la tua richiesta — L'800 Locanda a Palazzo`,
          html: htmlConferma,
        }),
      })
    );
  }

  const results = await Promise.allSettled(emails);
  const internalOk = results[0].status === 'fulfilled' && results[0].value.ok;

  if (!internalOk) {
    return json({ error: 'Invio non riuscito, riprova o scrivici su WhatsApp' }, 502);
  }

  return json({ ok: true });
}
