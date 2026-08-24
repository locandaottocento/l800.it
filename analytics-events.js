/**
 * analytics-events.js — L'800 Locanda a Palazzo
 * Tracking conversioni: Google Ads · Meta Pixel · GA4
 *
 * ── SETUP GOOGLE ADS ───────────────────────────────────────────────────────
 * Dopo aver creato le Conversion Actions in Google Ads vai in:
 *   Obiettivi → Conversioni → (apri ogni azione) → "Tag di Google"
 * e sostituisci i placeholder qui sotto con i valori reali.
 * Il Conversion ID è uguale per tutte (AW-XXXXXXXXX).
 * Il Conversion Label è diverso per ogni azione.
 */

(function () {
  'use strict';

  // ── CONFIGURAZIONE ────────────────────────────────────────────────────────
  var GADS_ID = 'AW-16773067765';
  var GADS_LABELS = {
    whatsapp:  'FwdtCIXjxq8cEPXngr4-',  // ✅ prenota-whatsapp
    telefono:  '1hkICKr94K8cEPXngr4-',  // ✅ chiamata-telefono
    octotable: 'Ly9vCN7G4a8cEPXngr4-',  // ✅ prenota-octotable
    voucher:   'kbD2COvN4a8cEPXngr4-',  // ✅ acquisto-voucher
    menuPdf:   'pL1jCIPU4a8cEPXngr4-',  // ✅ download-menu
  };
  var GADS_READY = true;

  // ── HELPER: Google Ads ────────────────────────────────────────────────────
  function gads(labelKey, value) {
    if (!GADS_READY) return;
    if (typeof gtag !== 'function') return;
    var params = { send_to: GADS_ID + '/' + GADS_LABELS[labelKey] };
    if (value) { params.value = value; params.currency = 'EUR'; }
    gtag('event', 'conversion', params);
  }

  // ── HELPER: Meta Pixel + Conversions API ──────────────────────────────────
  // Ogni evento viene inviato due volte: dal pixel browser e dal server (CAPI).
  // Meta deduplica le due copie tramite lo stesso `event_id`.
  function getCookie(name) {
    const value = '; ' + document.cookie;
    const parts = value.split('; ' + name + '=');
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
  }

  function generateEventId() {
    return 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  function hasAdConsent() {
    try {
      return localStorage.getItem('l800_cookie_consent') === 'true';
    } catch (e) {
      return false;
    }
  }

  function meta(eventName, params) {
    if (!hasAdConsent()) return;

    const eventId = generateEventId();

    if (typeof fbq === 'function') {
      fbq('track', eventName, params || {}, { eventID: eventId });
    }

    try {
      fetch('/meta-capi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_name: eventName,
          event_id: eventId,
          event_source_url: window.location.href,
          custom_data: params || {},
          fbp: getCookie('_fbp'),
          fbc: getCookie('_fbc'),
        }),
        keepalive: true,
      });
    } catch (e) {}
  }

  // ── HELPER: GA4 ───────────────────────────────────────────────────────────
  function ga4(eventName, params) {
    if (typeof gtag !== 'function') return;
    gtag('event', eventName, params || {});
  }

  // ── HELPER: GTM dataLayer ─────────────────────────────────────────────────
  function dlPush(obj) {
    if (typeof dataLayer !== 'undefined') dataLayer.push(obj);
  }

  // ── HELPER: lead unificato ────────────────────────────────────────────────
  // metodo: 'whatsapp' | 'telefono' | 'octotable'
  // Invia lo stesso parametro `metodo` in modo coerente a tutti i sistemi:
  //   GA4         → generate_lead { method, metodo }
  //   Meta        → Schedule (whatsapp/octotable) o Contact (telefono)
  //                 { content_name: 'lead_' + metodo, metodo }
  //   Google Ads  → conversion (label specifica del metodo)
  //   GTM         → l800_lead { metodo }
  function trackLead(metodo) {
    var eventName = (metodo === 'whatsapp' || metodo === 'octotable') ? 'Schedule' : 'Contact';
    ga4('generate_lead', { method: metodo, metodo: metodo });
    meta(eventName, { content_name: 'lead_' + metodo, metodo: metodo });
    gads(metodo);
    dlPush({ event: 'l800_lead', metodo: metodo });
  }

  // ── EVENTO: WhatsApp prenota ──────────────────────────────────────────────
  function setupWhatsApp() {
    document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp"]').forEach(function (el) {
      el.addEventListener('click', function () {
        trackLead('whatsapp');
      });
    });
  }

  // ── EVENTO: Chiamata telefono ─────────────────────────────────────────────
  function setupTelefono() {
    document.querySelectorAll('a[href^="tel:"]').forEach(function (el) {
      el.addEventListener('click', function () {
        trackLead('telefono');
      });
    });
  }

  // ── EVENTO: Prenota su Octotable ──────────────────────────────────────────
  function setupOctotable() {
    document.querySelectorAll('a[href*="octotable"]').forEach(function (el) {
      el.addEventListener('click', function () {
        trackLead('octotable');
      });
    });
  }

  // ── EVENTO: Download / Visualizza PDF menu ────────────────────────────────
  function setupMenuPdf() {
    // Copre: link .btn-view (↗ Visualizza), link .menu-switch-pdf (↓ PDF),
    // e qualsiasi link diretto a un file .pdf
    document.querySelectorAll(
      'a[href$=".pdf"], a.btn-view, a.menu-switch-pdf'
    ).forEach(function (el) {
      el.addEventListener('click', function () {
        var href  = el.getAttribute('href') || '';
        var nome  = href.split('/').pop().replace('.pdf', '') || 'menu';
        ga4('view_item', { item_id: nome, item_name: nome });
        meta('ViewContent', { content_name: 'pdf_' + nome, content_category: 'menu_pdf' });
        gads('menuPdf');
        dlPush({ event: 'l800_menu_pdf', pdf: nome });
      });
    });
  }

  // ── EVENTO: Acquisto buono regalo ─────────────────────────────────────────
  // Chiamata da buoni.html → mostraConferma() dopo res.ok
  // Parametri: value (€), numPortate (3|4), numPersone (int), codice (string)
  window.trackVoucherPurchase = function (value, numPortate, numPersone, codice) {
    var itemId  = 'voucher_' + numPortate + 'portate';
    var txId    = codice || ('V-' + Date.now());

    // GA4 — evento purchase standard (visibile in GA4 → Acquisti)
    ga4('purchase', {
      transaction_id: txId,
      value:          value,
      currency:       'EUR',
      items: [{
        item_id:   itemId,
        item_name: 'Buono Regalo ' + numPortate + ' portate',
        quantity:  numPersone,
        price:     (value / numPersone).toFixed(2),
      }],
    });

    // Meta Pixel — evento Purchase standard
    meta('Purchase', {
      value:        value,
      currency:     'EUR',
      content_ids:  [itemId],
      content_type: 'product',
      num_items:    numPersone,
    });

    // Google Ads — conversione con valore
    gads('voucher', value);

    // GTM dataLayer — per tag personalizzati se servono in futuro
    dlPush({
      event:        'l800_purchase',
      value:        value,
      currency:     'EUR',
      num_portate:  numPortate,
      num_persone:  numPersone,
      transaction_id: txId,
    });
  };

  // ── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    setupWhatsApp();
    setupTelefono();
    setupOctotable();
    setupMenuPdf();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
