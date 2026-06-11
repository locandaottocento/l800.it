// Cloudflare Pages Function: newsletter
// Endpoint: POST /newsletter
// Salva l'email in KV (prefisso newsletter:) e notifica info@l800.it

const RESEND_URL = 'https://api.resend.com/emails';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
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

  const { email, lang } = body;

  // Honeypot anti-spam
  if (body.website) return json({ ok: true });

  const emailClean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean) || emailClean.length > 120) {
    return json({ error: lang === 'en' ? 'Invalid email address' : 'Indirizzo email non valido' }, 400);
  }

  if (!env.VOUCHERS) return json({ error: 'Storage non configurato' }, 500);

  const key = `newsletter:${emailClean}`;
  const existing = await env.VOUCHERS.get(key);
  if (existing) {
    // Già iscritto: rispondiamo ok senza duplicare né rinotificare
    return json({ ok: true, already: true });
  }

  const record = {
    email: emailClean,
    lang: lang === 'en' ? 'en' : 'it',
    data: new Date().toISOString(),
    fonte: 'sito',
  };
  await env.VOUCHERS.put(key, JSON.stringify(record));

  // Notifica a info@l800.it (best effort, non blocca la risposta)
  if (env.RESEND_API_KEY) {
    const html = `<!DOCTYPE html><html><body style="font-family:Georgia,serif;color:#2a1a10;max-width:560px;margin:0 auto;padding:24px;">
<div style="text-align:center;padding:24px;background:#4a2612;"><div style="font-size:36px;font-style:italic;color:#fbf7ef;">L&rsquo;800</div><div style="font-size:8px;letter-spacing:4px;color:#d9b988;text-transform:uppercase;margin-top:4px;">Locanda a Palazzo &middot; Amantea</div></div>
<div style="padding:32px 8px;">
  <h2 style="color:#6f3b1c;border-bottom:2px solid #d9b988;padding-bottom:8px;font-size:20px;font-weight:normal;">Nuova iscrizione newsletter</h2>
  <table style="width:100%;border-collapse:collapse;font-size:15px;margin-top:16px;">
    <tr><td style="padding:8px 0;color:#8a5630;width:140px;">Email</td><td style="padding:8px 0;"><strong>${emailClean}</strong></td></tr>
    <tr><td style="padding:8px 0;color:#8a5630;">Lingua</td><td style="padding:8px 0;">${record.lang === 'en' ? 'Inglese' : 'Italiano'}</td></tr>
    <tr><td style="padding:8px 0;color:#8a5630;">Data</td><td style="padding:8px 0;">${new Date(record.data).toLocaleString('it-IT', { dateStyle: 'long', timeStyle: 'short' })}</td></tr>
    <tr><td style="padding:8px 0;color:#8a5630;">Fonte</td><td style="padding:8px 0;">${record.fonte}</td></tr>
  </table>
  <p style="margin-top:24px;font-size:12px;color:#8a5630;">Puoi gestire gli iscritti dalla dashboard, sezione Newsletter.</p>
</div></body></html>`;

    fetch(RESEND_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: "Sito L'800 <info@l800.it>",
        to: ['info@l800.it'],
        subject: `Nuova iscrizione newsletter: ${emailClean}`,
        html,
        text: `Nuova iscrizione alla newsletter dal sito.\nEmail: ${emailClean}\nLingua: ${record.lang}\nData: ${record.data}\nFonte: ${record.fonte}`,
      }),
    }).catch(() => {});
  }

  return json({ ok: true });
}
