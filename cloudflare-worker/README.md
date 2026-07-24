# Budai Tánc – Cloudflare webhook és CSV-import

Ez a Worker a WordPress plugin publikus fogadóoldala, és egy titkos URL-en
kézi CSV-importot is biztosít. A Google Sheets API-t a Worker a Google service
accounttal közvetlenül hívja, nincs szükség Google Cloud Runra.

## Egyszeri telepítés

1. Telepítsd a Node.js LTS-t, majd ebben a mappában futtasd:

   ```bash
   npm install --save-dev wrangler
   npx wrangler login
   ```

2. Állítsd be a két titkot. A parancs kéri be az értéket, ezért nem kerül a
   terminál-előzménybe.

   ```bash
   npx wrangler secret put WEBHOOK_SHARED_SECRET
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT
   npx wrangler secret put IMPORT_ADMIN_TOKEN
   npx wrangler secret put SYNC_ADMIN_TOKEN
   ```

   A másodikhoz a Google service account JSON fájl **teljes tartalma** kell,
   egyetlen JSON-ként (nem a fájl útvonala).

3. Add meg a pipeline-beállítást Worker változóként. A valódi értékhez a
   `pipelines.json.example` tartalmát használd, és a `replace_me` sort hagyd ki
   vagy töltsd ki később.

   ```bash
   npx wrangler secret put PIPELINES_CONFIG_JSON
   ```

   Ez nem érzékeny, de secretként kezeljük, hogy egyetlen helyen legyen a
   telepítési konfiguráció.

4. Deploy:

   ```bash
   npx wrangler deploy
   ```

   A parancs kiírja a publikus URL-t, például:

   `https://budaitancklub-registration-webhook.<subdomain>.workers.dev`

5. Ellenőrzés:

   ```bash
   curl https://...workers.dev/healthz
   ```

   Várt válasz: `{"status":"ok"}`.

6. A WordPress pluginban az `endpoint_url` értékét írd át erre:

   `https://...workers.dev/webhooks/gravity-forms`

## Kézi CSV-import

Az ügyfél a következő formájú URL-en tölthet fel teljes Gravity Forms
tánctanfolyam-exportot:

`https://...workers.dev/import/<IMPORT_ADMIN_TOKEN>`

Az URL jelenleg titkos linkként működik, Cloudflare Access nélkül. A token
legyen hosszú, véletlenszerű érték; ne kerüljön e-mail tárgyába vagy nyilvános
helyre. Ha később Access-védelemre váltunk, az engedélyezett címek:

- `budaitancklub@kult2.hu`
- `sziranyi.laura@kult2.hu`

Az import kizárólag a teljes tanfolyam-export fejlécét fogadja el. A hiányos
`gf_entry_4` exportot elutasítja. Meglévő rekordnál a J:M kézi oszlopok
megmaradnak; a Gravity Forms bejegyzésazonosító a látható első, `Közlemény`
oszlopban tárolódik.

## Munkatársi Sheet szinkron

A pipeline `staff_target` beállítása esetén a Worker minden új webhook- és
CSV-rekordot a fő Sheet mellett a munkatársi Sheetbe is beír. A munkatársi
Sheetben csak az `A:H` mezők szinkronizáltak; a további kézi, pénzügyi és
megjegyzés-oszlopok érintetlenek maradnak.

A fő Sheethez kötött Apps Script a `Budai Tánc → Munkatársi Sheet
szinkronizálása` menüponttal indít teljes egyeztetést. A kód az
`../apps-script/master-sheet-sync.gs` fájlban van. A token egyszeri megadása
a Script Properties-ben történik. A szinkron fizikailag törli a munkatársi
Sheetből azokat az azonosítóval ellátott sorokat, amelyek már nincsenek a fő
Sheetben.

## Tesztelés

```bash
npm run check
npm run test:smoke
```

A `test-fixtures/dami-registration.csv` egy teljes, személyes adatot nem
tartalmazó dummy export. A smoke teszt ellenőrzi az új rekord beszúrását, az
azonos rekord frissítését, az I:L mezők megőrzését, a hibás fejléc elutasítását
és a webhook 25 oszlopos mappelését. Production smoke teszt esetén a
`TEST-CODEX-20260723-001` és `TEST-WEBHOOK-001` azonosítókat a végén célzottan
ellenőrizni és törölni kell.

## Új űrlap / új folyamat

Minden új Gravity Forms űrlaphoz:

1. a WordPress plugin `BUDAI_TANC_WEBHOOK_PIPELINES` listájába új elem kerül;
2. itt a `PIPELINES_CONFIG_JSON`-be ugyanazzal a `pipeline_id`-val új elem kerül;
3. ha eltérő mezőstruktúrájú (például verseny), a Workerben új adaptert kell
   hozzáadni a `payloadToRow` függvényhez.

Az azonos `pipeline_id` kapcsolja össze a WordPress űrlapot a cél Google
Sheettel.
