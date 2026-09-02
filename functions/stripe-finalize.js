// Cloudflare Pages Function: stripe-finalize
// Endpoint: POST /stripe-finalize
// Chiamata dal client subito dopo che stripe.confirmPayment() ha restituito
// paymentIntent.status === 'succeeded'. NON ci fidiamo di questo stato lato
// client: qui lo verifichiamo di nuovo interrogando direttamente l'API Stripe
// (stesso principio di verifyPaypalOrder in send-voucher.js).
//
// L'importo non va ricalcolato: è già stato fissato server-side alla creazione
// del PaymentIntent (stripe-create-intent.js), quindi non può essere manomesso
// dal client in questo passaggio.
//
// Risposta: { success: true, codiceVoucher, scadenza }
// Dopo questa chiamata, il client genera il PDF e chiama /send-voucher
// (Fase 2, invariata) per l'invio delle email — esattamente come per PayPal.

import { jsonResponse, buildCors, stripeRequest, finalizeStripeOrder } from './_stripe-lib.js';

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 200, headers: buildCors(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const cors = buildCors(request.headers.get('Origin'));

  if (!env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY mancante');
    return jsonResponse({ error: 'Verifica pagamento non disponibile' }, 500, cors);
  }

  let d;
  try {
    d = await request.json();
  } catch {
    return jsonResponse({ error: 'Body JSON non valido' }, 400, cors);
  }

  const paymentIntentId = String(d.paymentIntentId || '').trim();
  if (!paymentIntentId.startsWith('pi_')) {
    return jsonResponse({ error: 'paymentIntentId non valido' }, 400, cors);
  }

  try {
    const paymentIntent = await stripeRequest(env, 'GET', `/payment_intents/${encodeURIComponent(paymentIntentId)}`);

    if (paymentIntent.status !== 'succeeded') {
      console.error('Pagamento Stripe non succeeded:', paymentIntentId, paymentIntent.status);
      return jsonResponse({ error: 'Pagamento non confermato', reason: paymentIntent.status }, 402, cors);
    }

    const result = await finalizeStripeOrder(paymentIntent, env, waitUntil);
    return jsonResponse({ success: true, codiceVoucher: result.codiceVoucher, scadenza: result.scadenza }, 200, cors);
  } catch (err) {
    console.error('stripe-finalize error:', err.message, err.stripeError || '');
    return jsonResponse({ error: 'Errore nella verifica del pagamento. Contattaci su WhatsApp.' }, 502, cors);
  }
}
