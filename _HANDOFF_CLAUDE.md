# HANDOFF — Sito L'800 Locanda a Palazzo

> Questo file serve a Claude per riprendere il lavoro sul sito in una nuova chat
> senza perdere contesto. Mauro è il proprietario del ristorante.
> **Ambito di questa chat: SOLO sito web.** Le campagne pubblicitarie si gestiscono altrove.

---

## 1. COS'È IL PROGETTO

Sito web del ristorante **L'800 Locanda a Palazzo**, Amantea (CS), Calabria.
Ristorante di pesce calabrese in un palazzo dell'Ottocento con giardino.

- **Sito live:** https://www.l800.it
- **Tipo:** sito statico HTML/CSS/JS (niente framework, niente build step lato sviluppo)
- **Hosting:** Cloudflare Pages (NON Netlify — ma i file `_redirects` e `_headers` in stile Netlify sono supportati da Cloudflare Pages)
- **Deploy:** Mauro carica manualmente uno ZIP su GitHub → Cloudflare Pages fa il deploy automatico
- **Bilingue:** italiano (root) + inglese (cartella `/en/`)

### Come lavora Claude su questo progetto
Quando Mauro chiede una modifica, Claude:
1. Lavora sui file nella working directory
2. Verifica le modifiche (spesso con screenshot via Playwright o validazione codice)
3. Rigenera lo ZIP completo in output e lo presenta
4. Mauro scarica lo ZIP e lo carica su GitHub

---

## 2. STRUTTURA FILE

### HTML — 24 pagine (12 IT in root + 12 EN in /en/)
```
index.html              → homepage
prenota.html            → pagina prenotazione (WhatsApp + Octotable)
menu.html               → overview con i 3 PDF dei menu (iframe diretto)
menu-cibo.html          → menu cibo in HTML (con tab switcher Cibo/Vini/Dolci/PDF)
menu-vini.html          → carta vini in HTML
menu-dolci.html         → dolci e fine pasto in HTML
storia.html             → storia del ristorante (timeline)
eventi.html             → eventi e cerimonie (con slideshow)
buoni.html              → e-commerce buoni regalo (PayPal + email)
cookie-policy.html
privacy-policy.html
termini-condizioni.html
```
Le stesse 12 pagine esistono in `/en/` (versione inglese).

### Codice funzionale
- `functions/send-voucher.js` — Cloudflare Pages Function (endpoint POST `/send-voucher`).
  Verifica il pagamento PayPal lato server (anti-frode: confronta importo con `{3:50, 4:65}×persone`),
  invia l'email del voucher con PDF allegato via **Resend API**, e ha la **Meta CAPI server-side**
  predisposta (evento Purchase) — attiva solo se le env var META_CAPI_TOKEN + META_PIXEL_ID sono settate.
  Tutte le fetch usano `fetchWithTimeout()` (8-10s) per evitare 504.
- `analytics-events.js` — tracking conversioni, caricato con `defer` in tutte le 24 pagine.

### Config / SEO
- `_headers` — security headers (X-Frame-Options SAMEORIGIN, ecc.) + cache rules
- `_redirects` — redirect (en-US→en, it→root, home→root, EN pretty URLs→.html)
- `robots.txt`, `sitemap.xml` (18 URL con hreflang), `manifest.json`

### Asset
- Immagini: hero-giardino, sala-interna, evento-sala-1…6, evento-sala-interna,
  crudite-pesce-fresco, tagliolini-arancia-gamberi-rossi, filetto-spigola-pistacchio,
  giardino-eventi-drone, mappa-doc-calabria
- Favicon/icone: favicon-16/32, apple-touch-icon, icon-192/512, icon-maskable-512
- Loghi: logo-orizzontale.png, logo-primario.png, og-image.png
- PDF: menu.pdf, carta-dei-vini.pdf, menu-dolci.pdf
- NOTA: la cartella `/brand/` (loghi in tutte le varianti) è stata RIMOSSA dal deploy
  per alleggerire; è archiviata a parte in `brand-archive.zip` sul computer di Mauro.

---

## 3. IDENTITÀ VISIVA (design tokens)

| Token | HEX | Uso |
|---|---|---|
| cream | #fbf7ef | sfondo chiaro |
| cream-light | #fbf7ef | testo su scuro |
| cream-dark | (sfondo sezioni alternate) | |
| brown / tabacco | #6f3b1c | colore primario, testo su chiaro |
| brown-dark | #4a2612 | sfondi scuri (hero, footer) |
| brown-pale / sabbia | #d9b988 | accenti, testo su scuro |
| gold | #b8893f | dettagli (usare con cautela: basso contrasto su crema) |
| text / inchiostro | #2a1a10 | testo principale |
| text-light | #5e5046 | testo secondario |

- **Font:** Cormorant Garamond (titoli e body) + Cormorant SC (small caps, label/eyebrow)
- **Stile:** elegante, ornamenti ✦, divisori, palazzo storico
- **Regola contrasti:** su sfondo SCURO usare testo chiaro (cream/sabbia); su sfondo CHIARO
  usare testo scuro (brown/brown-dark). Errore ricorrente da evitare: testo brown su overlay scuro.

---

## 4. DATI RISTORANTE

- **Indirizzo:** Via Calavecchia 53, 87032 Amantea (CS), Calabria
- **Tel:** +39 0982 428262 · **Email:** info@l800.it · **P.IVA:** 03906130780
- **Orari:** Martedì–Domenica, pranzo 12:30–14:30, cena 19:30–22:00. **CHIUSO MERCOLEDÌ.**
- **Prenotazioni:** WhatsApp (canale primario, wa.me/390982428262) + Octotable (ID 561331, secondario)
- **Buoni regalo:** €50 (3 portate) · €65 (4 portate). Validi 12 mesi, consegnati via email.
- **NO delivery / NO takeaway**
- **Recensioni:** TripAdvisor 4.8★ (540+, Travellers' Choice 2022) · Google 4.3★ (542)
- **Social:** TikTok @l800locandaapalazzo, Instagram + Facebook (l800locandaapalazzo)

### Preferenze di Mauro
- Risposte concrete, asciutte, operative. Niente entusiasmi esagerati.
- Chiede chiarimenti prima di azioni complesse, conferma le decisioni.
- Attento alla coerenza del brand e alla leggibilità/contrasti.
- Procede volentieri passo-passo con guide visive quando serve.
- Nessun prezzo nei menu HTML (i prezzi stanno solo nei PDF).
- **Nomi dei piatti nei menu EN: lasciati VOLUTAMENTE in italiano** (scelta di autenticità).
- **Recensioni clienti: lasciate in lingua originale** (sono testimonianze reali).

---

## 5. TRACKING & INTEGRAZIONI (già installato — NON modificare se non richiesto)

- **GTM:** GTM-TGDTNGVH
- **GA4:** G-FT44KNVT1E (property 466989484)
- **Meta Pixel:** 1266689621145892
- **Google Ads Conversion ID:** AW-16773067765
  - whatsapp → `FwdtCIXjxq8cEPXngr4-`
  - telefono → `1hkICKr94K8cEPXngr4-`
  - octotable → `Ly9vCN7G4a8cEPXngr4-`
  - voucher → `kbD2COvN4a8cEPXngr4-`
  - menuPdf → `pL1jCIPU4a8cEPXngr4-`
- `analytics-events.js` usa la funzione `trackLead(metodo)` con parametro **`metodo`**
  (valori: whatsapp / telefono / octotable). Invia a GA4 + Meta + Google Ads + GTM dataLayer.
- Eventi tracciati: WhatsApp, telefono, Octotable, click PDF menu, acquisto voucher.

### Variabili d'ambiente Cloudflare Pages (già configurate da Mauro)
- `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `RESEND_API_KEY` (tutte Secret)
- `META_PIXEL_ID` = 1266689621145892 (Text)
- `META_CAPI_TOKEN` (Secret) — NON ancora generato (Mauro ha avuto problemi con Meta);
  la CAPI è predisposta nel codice ma inattiva finché manca il token. Va bene così per ora.

---

## 6. LAVORO SVOLTO NELLE SESSIONI PRECEDENTI

Cronologia sintetica degli interventi già completati (NON rifare, è già nel codice):

1. **Rebrand v2** — palette tabacco/sabbia, nuovi loghi, font Cormorant.
2. **Audit accessibilità/contrasti** — da 374 a ~8 violazioni WCAG (98% risolto).
3. **Bug PDF "schermo intero"** — risolto cambiando X-Frame-Options DENY→SAMEORIGIN.
4. **Menu redesign** — tab switcher [Cibo · Vini · Dolci · ↓ PDF] in cima alle 3 pagine menu;
   nav interna sezioni resa più visibile (font 12px, colore tabacco, weight 500/600).
   Viewer PDF cambiato da Google Docs Viewer (instabile) a iframe diretto same-origin.
   Link "Menu" del nav globale uniformato → punta a menu-cibo.html ovunque.
5. **Cache Cloudflare** (`_headers`) — immagini 30gg, PDF `no-cache` (sempre ultima versione),
   HTML 1h, font 1 anno. `fetchWithTimeout` in send-voucher.js per evitare 504.
6. **File `_redirects`** — redirect legacy + EN pretty URLs.
7. **Tracking conversioni completo** — analytics-events.js + Meta CAPI server-side predisposta.
8. **Refactor lead** — funzione `trackLead(metodo)` unica con parametro `metodo`.
9. **SEO mirato** — hreflang corretti, JSON-LD con hasMenu + sameAs social, title con "Amantea",
   meta description CTR-oriented.
10. **Schema.org buoni regalo** (Search Console "3 schede non valide") — aggiunti `image`,
    `hasMerchantReturnPolicy` (non rimborsabile), `shippingDetails` (consegna digitale gratuita),
    `url`, `priceValidUntil` a ogni offerta.
11. **Fix homepage "Occasioni speciali"** — testo card "Il nostro giardino" / "Le sale del palazzo"
    reso leggibile (era testo scuro su overlay scuro → ora chiaro). Immagine sala spostata a
    `object-position: center 72%` per mostrare più tavoli e meno soffitto.
12. **Traduzioni EN residue** — card occasioni, CTA menu-vini ("Decided what to order?" /
    "Food menu" / "Desserts & after dinner"), "Indirizzo"→"Address" nei termini,
    nota carne/pesce in menu-cibo. (Nomi piatti lasciati in IT per scelta.)
13. **OTTIMIZZAZIONE PAGESPEED MOBILE** (ultimo intervento):
    - `robots.txt`: `Allow: /` → `Disallow:` vuoto (fix errore validatore SEO Lighthouse)
    - **Font Google async**: preload + `media="print" onload` trick + `<noscript>` fallback,
      in tutte le 24 pagine. Elimina ~1920ms di render-blocking.
    - **Hero LCP**: rimosso `loading="lazy"`, aggiunto `fetchpriority="high"` + dimensioni
      width/height + `<link rel="preload" as="image">` nel `<head>`. (L'hero era erroneamente lazy.)
    - **Immagini ricompresse** a qualità 82 progressive + ridimensionate max 1600px (-792K, -16%).
      Loghi PNG ottimizzati (-23/27%).
14. **CONVERSIONE IMMAGINI IN WEBP** (23 mag 2026, ultimo intervento):
    - 14 foto convertite JPG/PNG → WebP q80 (mappa q85), ridimensionate alle misure di display
      reali: hero 1100w, foto piatti 800w, sala 900w, foto eventi 1200w, mappa 760w. **-61% peso**
      (3374K → 1305K). Hero 167K→88K; foto piatti ~250K→~45K l'una.
    - **Sostituzione diretta** `.jpg`→`.webp` nei src (NO tag `<picture>`: WebP supportato ~98%).
      Aggiornati src, preload hero e JSON-LD "image" su index/eventi/prenota (IT+EN).
    - **Bug LCP residuo risolto**: la hero EN (en/index.html) era ANCORA `loading="lazy"`
      (il fix #13 aveva sistemato solo la IT) → ora `fetchpriority="high"` su entrambe.
    - **Aspect ratio hero corretto**: era `width=800 height=1000` ma il file reale è 900×1200
      → ora `800×1067` (proporzioni reali) su IT+EN.
    - Vecchi JPG e mappa-doc-calabria.png RIMOSSI dal pacchetto (non più referenziati).
    - `_headers` già conteneva la regola `/*.webp` (cache 30gg) → nessuna modifica necessaria.
    - NON toccati: og-image.png (Open Graph richiede JPG/PNG), favicon, icone PWA, loghi orfani.

### Punteggi PageSpeed (mobile) — storico
- PRIMA deploy #13: Prestazioni **59** · LCP ~7s
- DOPO deploy #13 (test 23 mag): Prestazioni **62-77** (ballerino) · LCP **4,2-8,3s** · TBT 250-420ms.
  L'LCP alto era causato dalla hero (pesante + EN ancora lazy) → attaccato col deploy #14.
- DOPO deploy #14 (WebP): attesa verifica. LCP atteso in forte calo (hero -47% peso, non più lazy).
- Punteggi mobile resteranno variabili per via di GTM/gtag/Meta (terze parti, non ottimizzabili da codice).

---

## 7. COSE IN SOSPESO / NOTE

- **robots.txt riga 29 `Content-Signal: search=yes, ai-train=no`** (errore SEO Lighthouse, costa
  il 100→92): NON è nei file del progetto, è iniettato automaticamente da **Cloudflare**
  (funzione "AI Crawl Control" / "Content Signals", attiva di default). VA SISTEMATO DAL DASHBOARD
  CLOUDFLARE, non dal codice. In alternativa lasciare 92 (non incide sul ranking reale). Mauro
  deve ancora decidere/agire.
- **WebP**: FATTO (deploy #14). Dopo il deploy verificare il nuovo LCP mobile su PageSpeed.
- **PDF menu EN**: i path sono predisposti ma Mauro deve fornire i PDF tradotti.
- **Meta CAPI**: codice pronto, manca solo il token (vedi sezione 5).
- **Search Console**: dopo deploy schema buoni, cliccare "Convalida correzione" su
  "Schede commercianti".

---

## 8. COME RIPRENDERE

I file completi e aggiornati del sito sono nello ZIP allegato a questa chat
(`l800_github_package.zip`). Claude può estrarli nella working directory e lavorarci.
Per qualsiasi modifica: modificare i file, verificare, rigenerare lo ZIP, presentarlo a Mauro.
