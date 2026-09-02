// Cloudflare Pages Function: stripe-webhook
// Endpoint: POST /stripe-webhook (chiamato da Stripe, non dal browser — niente CORS)
// Rete di sicurezza: se il cliente chiude il browser subito dopo il pagamento
// (prima che /stripe-finalize venga chiamato), questo webhook garantisce comunque
// che il voucher venga registrato nel KV e Mauro riceva la notifica interna.
// È idempotente rispetto a stripe-finalize.js: la dedup su `stripe:{paymentIntentId}`
// nel KV fa sì che processarlo due volte (finalize + webhook) sia innocuo.
//
// Env var richieste: STRIPE_WEBHOOK_SECRET

import { verifyStripeSignature, finalizeStripeOrder } from './_stripe-lib.js';

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET mancante — webhook rifiutato');
    return new Response('Webhook non configurato', { status: 500 });
  }

  const payload = await request.text();
  const sigHeader = request.headers.get('Stripe-Signature');

  const valid = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    console.error('Firma webhook Stripe non valida');
    return new Response('Firma non valida', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response('JSON non valido', { status: 400 });
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    try {
      await finalizeStripeOrder(paymentIntent, env, waitUntil);
    } catch (err) {
      console.error('stripe-webhook finalize error:', err.message);
      // Rispondiamo comunque 200 per evitare che Stripe continui a ritentare
      // all'infinito su un errore permanente; l'errore è già loggato per il debug.
    }
  }

  return new Response('ok', { status: 200 });
}
