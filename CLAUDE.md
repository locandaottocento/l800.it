# L'800 Locanda a Palazzo — Sito web

Sito del ristorante di pesce **L'800 Locanda a Palazzo**, Amantea (CS), Calabria.
Palazzo storico dell'Ottocento con giardino. Cucina di mare calabrese, fascia medio-alta.

---

## ⚙️ Regole operative (IMPORTANTE)

- **Lingua di lavoro:** italiano. Mauro è il proprietario e gestisce tutto da solo (sito, ads, analytics).
- **Modifiche dirette ai file** nella working directory. Il deploy avviene via `git push` (vedi sotto).
- Quando Mauro dice **"è tutto"** → fermati e aspetta.
- **Correzioni applicate subito**, senza lunghe spiegazioni: applica e conferma.
- **Iterativo e visivo:** Mauro rivede le anteprime/diff prima di confermare. Batch delle modifiche prima del deploy.
- **Tono risposte recensioni** (se richiesto): caldo ma non pomposo, conciso, diretto. Firma "Lo staff de L'800" o "Lo staff de L'800 Locanda a Palazzo".
- **Mai proporre automazioni Apps Script / pipeline GA4 automatiche:** Mauro preferisce export CSV manuali.

---

## 🏗️ Architettura

- **Sito statico** HTML/CSS/JS (nessun framework, nessun build step).
- **Bilingue:** root italiano (`/`) + cartella inglese (`/en/`). 24 pagine totali (12 IT + 12 EN).
- **Hosting:** Cloudflare Pages, deploy automatico da GitHub.
- **Dominio:** l800.it (registrar OVH, DNS su Cloudflare).
- Dominio secondario `locandadimare.it` → landing di redirect verso l800.it.

### Struttura file
```
/                    pagine IT (index, menu, menu-cibo, menu-vini, menu-dolci,
                     prenota, eventi, storia, buoni, privacy-policy,
                     cookie-policy, termini-condizioni)
/en/                 stesse pagine in inglese
/functions/          Cloudflare Functions (serverless)
/assets/             immagini (webp), font, risorse
analytics-events.js  tracking conversioni centralizzato
_redirects           301 redirect (clean URL + http->https)
_headers             header HTTP (cache, security)
robots.txt
*.pdf                menu scaricabili (menu.pdf, carta-dei-vini.pdf, menu-dolci.pdf)
dashboard.html       dashboard privata (voucher + newsletter)
```

---

## 🎨 Design system (v2 rebrand)

- **Palette:** cream / tabacco / brown / gold. Variabili CSS `--cream`, `--cream-dark`, `--cream-light`, `--brown`, `--brown-dark`, `--brown-light`, `--border`, `--text`, `--text-light`.
- **Font:** Cormorant Garamond (testo) + Cormorant SC (label/maiuscoletto).
- **Naming brand:** usa "dell'800" come riferimento standalone, NON "la Locanda".

---

## 🔧 Cloudflare Functions (/functions)

- `send-voucher.js` — verifica PayPal, invio email via Resend, evento Meta CAPI server-side.
- `newsletter.js` — iscrizione newsletter: salva in KV (prefisso `newsletter:`), notifica a info@l800.it. NESSUNA email di conferma all'iscritto (solo conferma in pagina).
- `richiesta-evento.js` — form richiesta eventi/matrimoni: email a info@l800.it + conferma bilingue al richiedente.
- `dashboard-api.js` — API dashboard: gestione voucher + newsletter (azioni `list`, `newsletter-list`, `newsletter-delete`).

### Risorse Cloudflare
- **KV namespace:** `VOUCHERS` (contiene sia `voucher:` che `newsletter:`).
- **Secret:** `DASHBOARD_PASSWORD`, `RESEND_API_KEY`.
- **Email:** Resend → mittente/destinatario info@l800.it.
- **Pagamenti:** PayPal (acquisto voucher).
- ⚠️ Meta CAPI Purchase server-side: predisposto ma INATTIVO (manca token Meta Business).

---

## 📊 Tracking & Analytics

| Servizio | ID |
|---|---|
| GA4 | G-YB46NVHTED |
| Google Ads | AW-16773067765 |
| Meta Pixel | 1266689621145892 |
| GTM | GTM-TGDTNGVH |
| Microsoft Clarity | x37q9hafwm |
| Octotable (prenotazioni) | 561331 |

- **GA4 caricato via GTM** (NON via Cloudflare Zaraz — rimosso per evitare doppio caricamento).
- **analytics-events.js:** funzione `trackLead(metodo)` con valori `whatsapp`, `telefono`, `octotable`. Evento conversione chiave: `l800_lead`. Label Google Ads in `GADS_LABELS`.
- **Lazy-loading tracking (INP):** GTM, Pixel e Clarity sono avvolti in `window.__l800_gtm/_pixel/_clarity` e attivati da un loader al primo input utente (scroll/tap/click/keydown/mousemove) o dopo 3.5s. Il **consent mode GDPR gira sempre subito** all'avvio — non spostarlo dentro il lazy-load.

---

## 🔍 SEO

- **Clean URL:** niente `.html` negli URL pubblici. 30 regole 301 in `_redirects` (IT+EN, http->https).
- ⚠️ Serve anche "Always Use HTTPS" attivo nel dashboard Cloudflare (SSL/TLS -> Edge Certificates).
- Canonical e og:url di tutte le pagine puntano ai clean URL.
- hreflang IT/EN, JSON-LD schema (Restaurant + Menu con hasMenu, BreadcrumbList).
- Title <=60 caratteri, meta description 140-160 caratteri.

---

## ⚠️ Trappole note (lezioni apprese)

- **Mobile nav:** `backdrop-filter` su `nav { position:fixed }` crea un containing block che rompe i figli `position:fixed` (la footer-sitemap saliva in cima). Fix: `position:static` su `.footer-sitemap`; `backdrop-filter` solo desktop via media query.
- **Anteprima PDF:** usare iframe `#toolbar=0&navpanes=0&scrollbar=0&view=FitH` dentro `.card-preview { overflow:hidden }` con `iframe { width:calc(100% + 17px) }` per nascondere la scrollbar. NON usare PDF.js (rompe il layout) ne immagini statiche (Mauro vuole il PDF sfogliabile).
- **X-Frame-Options** deve essere `SAMEORIGIN` (non `DENY`) per gli iframe PDF same-origin.
- **PDF carta vini:** il file pubblico si chiama `carta-dei-vini.pdf` (referenziato da menu.html IT+EN). Le pagine EN non hanno PDF separati: usano gli stessi file IT.
- **Cache PDF:** dopo ogni aggiornamento di un PDF, fare purge manuale su Cloudflare (Caching -> Cache Purge) dell'URL del file.

---

## 🚀 Deploy

Il sito si aggiorna con un push su GitHub (Cloudflare Pages fa il resto):

```bash
git add -A
git commit -m "descrizione modifica"
git push
```

Anteprima locale prima del deploy:
```bash
python3 -m http.server 8000
# poi apri http://localhost:8000
```

---

## 📋 Contatti & dati locale

- Indirizzo: Via Calavecchia 53, 87032 Amantea (CS)
- Tel: +39 0982 428262 · Email: info@l800.it · P.IVA 03906130780
- Orari: Mar-Dom, pranzo 12:30-14:30, cena 19:30-22:00 (chiuso mercoledi)
- Prenotazioni: WhatsApp (principale) + Octotable (ID 561331)
- Buoni regalo: €50 (3 portate), €65 (4 portate)
- Rating: TripAdvisor 4.8★ · Google 4.3★ · TheFork 9.3
