// Cloudflare Pages Function: meta-capi
// Endpoint: POST /meta-capi
// Inoltra gli eventi di conversione alla Meta Conversions API (server-side),
// in parallelo al pixel browser. La deduplica avviene tramite `event_id`,
// generato lato client e condiviso tra pixel e CAPI.
// Il token è letto da env.META_CAPI_TOKEN (secret su Cloudflare Pages).

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    const { event_name, event_id, event_source_url, custom_data, fbp, fbc } = body;

    const clientIp = request.headers.get('CF-Connecting-IP') || '';
    const userAgent = request.headers.get('User-Agent') || '';

    const payload = {
      data: [
        {
          event_name,
          event_time: Math.floor(Date.now() / 1000),
          event_id,
          event_source_url,
          action_source: 'website',
          user_data: {
            client_ip_address: clientIp,
            client_user_agent: userAgent,
            ...(fbp ? { fbp } : {}),
            ...(fbc ? { fbc } : {}),
          },
          custom_data: custom_data || {},
        },
      ],
    };

    const res = await fetch(
      `https://graph.facebook.com/v19.0/1266689621145892/events?access_token=${env.META_CAPI_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    const result = await res.json();
    return new Response(JSON.stringify(result), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
