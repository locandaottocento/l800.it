# L'800 — Locanda a Palazzo
## Brand Asset Package

Pacchetto completo di asset grafici per l'identità di **L'800 – Locanda a Palazzo**, pronto per essere utilizzato sul sito web, social network, materiali stampati, packaging e merchandising.

---

## 📁 Struttura cartelle

```
brand/
├── logo/         Logo nelle sue varianti complete (verticale + orizzontale)
├── wordmark/     Solo lettering "L'800"
├── icon/         Solo palazzo (submark / icona)
├── favicon/      Set completo per browser e mobile
├── social/       Open Graph, Instagram, profili, storie
├── css/          Variabili CSS (colori, font, spaziature)
└── style-guide.html   Pagina di documentazione interattiva
```

---

## 🎨 Palette colori

| Nome | Hex | Uso |
|------|-----|-----|
| **Tabacco** | `#6f3b1c` | Colore primario, testo, palazzo |
| **Tabacco scuro** | `#4a2612` | Fondi scuri, packaging premium |
| **Tabacco chiaro** | `#8a5630` | Hover, link, dettagli |
| **Sabbia** | `#d9b988` | Sottotitoli, accenti, oro |
| **Sabbia chiara** | `#ecd9b6` | Crema, fondi tenui |
| **Crema** | `#fbf7ef` | Fondo pagina caldo |
| **Inchiostro** | `#2a1a10` | Testo principale |

---

## 🔤 Font

- **Lettering "L'800"** → usare SEMPRE l'immagine PNG/SVG fornita (è il lettering originale del logo, non un font scaricabile)
- **Titoli + sottotitoli (es. "LOCANDA A PALAZZO")** → [Cormorant Garamond](https://fonts.google.com/specimen/Cormorant+Garamond), maiuscolo, letter-spacing `0.42em`
- **Testo (body) + UI** → [Inter](https://fonts.google.com/specimen/Inter) o `system-ui`

```html
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
```

---

## 🖼️ Come usare i logo

### Logo primario (quadrato)
Per applicazioni dove serve respiro intorno al logo (homepage, copertine).
- `logo/logo-primario-trasparente.png` — qualunque fondo chiaro
- `logo/logo-primario-crema.png` — fondo crema
- `logo/logo-primario-bianco.png` — fondo bianco
- `logo/logo-primario-tabacco.png` — fondo scuro (versione invertita)

### Logo orizzontale
Per header del sito, letterhead, footer, firma email.
- `logo/logo-orizzontale-trasparente.png`
- `logo/logo-orizzontale-crema.png`
- `logo/logo-orizzontale-bianco.png`
- `logo/logo-orizzontale-tabacco.png`

### Wordmark "L'800"
Solo lettering, quando il palazzo non è necessario (etichette vino, intestazioni interne).
- `wordmark/l800-*.png`

### Submark / Icona palazzo
Per favicon, watermark, decorazioni, pattern, social profile.
- `icon/palazzo-*.png`

---

## 🌐 Favicon (sito web)

Inserisci questo nel `<head>` del sito:

```html
<link rel="icon" type="image/png" sizes="16x16" href="/brand/favicon/favicon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon/favicon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="/brand/favicon/favicon-48.png">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/favicon/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
```

`site.webmanifest` minimo:
```json
{
  "name": "L'800 — Locanda a Palazzo",
  "short_name": "L'800",
  "icons": [
    { "src": "/brand/favicon/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/brand/favicon/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/brand/favicon/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "theme_color": "#6f3b1c",
  "background_color": "#fbf7ef",
  "display": "standalone"
}
```

---

## 📱 Social media

- **Open Graph** (preview Facebook/Twitter/LinkedIn) → `social/og-image-crema.png` (1200×630)
- **Instagram post** → `social/instagram-quadrato-*.png` (1080×1080)
- **Storia IG/FB** → `social/storia-*.png` (1080×1920)
- **Foto profilo** → `social/profilo-*.png` (400×400)

Open Graph nel `<head>`:
```html
<meta property="og:image" content="https://tuosito.it/brand/social/og-image-crema.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
```

---

## ⚠️ Regole d'uso

✅ **Fare**
- Mantenere proporzioni e padding minimi
- Usare le varianti invertite (cream/tabacco) su fondi scuri
- Lasciare almeno un'altezza del palazzo come margine bianco

❌ **Non fare**
- Modificare i colori del logo
- Distorcere, ruotare, applicare ombre o gradienti
- Sostituire il lettering "L'800" con un font calligrafico simile
- Sovrapporre il logo a immagini molto contrastate senza riquadro

---

## 📄 Style guide interattiva

Apri `style-guide.html` per una pagina completa con preview di tutti gli asset, palette colori, snippet di codice e download diretto.
