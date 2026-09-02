// Cloudflare Pages Function: stripe-create-intent
// Endpoint: POST /stripe-create-intent
// Crea un PaymentIntent Stripe con l'importo calcolato SOLO lato server
// (anti-frode, stesso principio già usato per PayPal in send-voucher.js).
// I dati dell'ordine (nome, email, prodotto, ecc.) vengono salvati nei metadata
// del PaymentIntent così che stripe-finalize.js e stripe-webhook.js possano
// leggerli da una fonte fidata (Stripe), senza doversi fidare del client.
//
// Env var richieste: STRIPE_SECRET_KEY

import {
  jsonResponse, buildCors, calcolaImportoAtteso,
  IMPORTO_LIBERO_MIN, IMPORTO_LIBERO_MAX_TECNICO, stripeRequest,
} from './_stripe-lib.js';

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 200, headers: buildCors(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const cors = buildCors(request.headers.get('Origin'));

  if (!env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY mancante');
    return jsonResponse({ error: 'Pagamento non disponibile al momento' }, 500, cors);
  }

  let d;
  try {
    d = await request.json();
  } catch {
    return jsonResponse({ error: 'Body JSON non valido' }, 400, cors);
  }

  const required = ['nomeAcquirente', 'emailAcquirente', 'nomeDestinatario', 'prodotto'];
  for (const field of required) {
    if (!d[field]) return jsonResponse({ error: `Campo obbligatorio mancante: ${field}` }, 400, cors);
  }
  if (!EMAIL_RX.test(String(d.emailAcquirente).trim())) {
    return jsonResponse({ error: 'Email acquirente non valida' }, 400, cors);
  }
  if (d.emailDestinatario && String(d.emailDestinatario).trim() && !EMAIL_RX.test(String(d.emailDestinatario).trim())) {
    return jsonResponse({ error: 'Email destinatario non valida' }, 400, cors);
  }

  const isLibero = d.tipo === 'libero';
  let expectedAmount, numPortate = null, numPersone = null, importoLibero = 0;

  if (isLibero) {
    const imp = parseInt(d.importoLibero, 10);
    if (!Number.isInteger(imp) || imp < IMPORTO_LIBERO_MIN || imp > IMPORTO_LIBERO_MAX_TECNICO) {
      return jsonResponse({ error: 'Importo libero non valido' }, 400, cors);
    }
    importoLibero = imp;
    expectedAmount = imp;
  } else {
    numPersone = parseInt(d.numPersone, 10) || 1;
    if (numPersone < 1 || numPersone > 200) numPersone = 1;
    numPortate = parseInt(d.numPortate, 10);
    if (![3, 4].includes(numPortate)) {
      return jsonResponse({ error: 'numPortate non valido (atteso 3 o 4)' }, 400, cors);
    }
    expectedAmount = calcolaImportoAtteso(numPortate, numPersone);
    if (expectedAmount == null) {
      return jsonResponse({ error: 'Impossibile calcolare importo atteso' }, 400, cors);
    }
  }

  // Stripe metadata: valori come stringhe, max 500 caratteri l'uno.
  const metadata = {
    tipo: isLibero ? 'libero' : 'fisso',
    numPortate: numPortate != null ? String(numPortate) : '',
    numPersone: numPersone != null ? String(numPersone) : '',
    importoLibero: String(importoLibero),
    prodotto: String(d.prodotto).slice(0, 490),
    nomeAcquirente: String(d.nomeAcquirente).slice(0, 490),
    emailAcquirente: String(d.emailAcquirente).trim().slice(0, 490),
    nomeDestinatario: String(d.nomeDestinatario).slice(0, 490),
    emailDestinatario: String(d.emailDestinatario || '').trim().slice(0, 490),
    messaggioPersonale: String(d.messaggioPersonale || '').slice(0, 490),
  };

  try {
    // Metodi ristretti su richiesta: niente Link, Amazon Pay, Bancontact,
    // MB WAY, EPS. Apple Pay/Google Pay restano disponibili: nell'API Stripe
    // sono veicolati dal tipo 'card', non da un tipo a parte.
    const intent = await stripeRequest(env, 'POST', '/payment_intents', {
      amount: Math.round(expectedAmount * 100),
      currency: 'eur',
      payment_method_types: ['card', 'klarna', 'satispay'],
      description: `Buono regalo L'800 — ${d.prodotto}`.slice(0, 490),
      receipt_email: String(d.emailAcquirente).trim(),
      metadata,
    });
    return jsonResponse({ clientSecret: intent.client_secret, paymentIntentId: intent.id }, 200, cors);
  } catch (err) {
    console.error('stripe-create-intent error:', err.message, err.stripeError || '');
    return jsonResponse({ error: 'Impossibile avviare il pagamento. Riprova o contattaci su WhatsApp.' }, 502, cors);
  }
}
