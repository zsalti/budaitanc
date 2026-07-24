# Cloudflare Worker terv

## Cél

A jelenlegi rendszer két részre váljon:

1. lokális / Python import és admin eszközök
2. publikus webhook endpoint Cloudflare Workeren

Ez azért jó, mert:

- a CSV import és a gyors manuális feldolgozás marad a mostani Python kódban
- a publikus Gravity Forms webhook nem függ attól, hogy egy gép be van-e kapcsolva
- nincs szükség fizetős Google Cloud deployra

## Mi marad a mostani Python kódban

- `import_gravity_csv.py`
- a pipeline adapterek
- a rekordmodell
- a Google Sheets írási logika mint referencia

## Mit kell Cloudflare-re kivinni

Egy vékony webhook endpointot:

- `POST /webhooks/gravity-forms`
- header: `X-BudaiTanc-Secret`
- body: a WordPress plugin által küldött JSON payload

## Worker feladata

1. ellenőrizni a `X-BudaiTanc-Secret` értékét
2. kiolvasni a `pipeline_id` mezőt
3. a pipeline alapján kiválasztani a cél spreadsheetet és target fület
4. a payloadot a megfelelő rekordstruktúrára alakítani
5. Google Sheets API-n keresztül beírni a sort
6. JSON választ adni a WordPress felé

## Szükséges Cloudflare secret / env

- `WEBHOOK_SHARED_SECRET`
- `GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT`

Ajánlott még:

- `PIPELINES_CONFIG_JSON`

Ez utóbbi lehet:

- egy JSON string Worker secretként / env-ként, vagy
- kezdetben simán a Worker kódba égetett config

## Google hitelesítés

A service account JSON-t nem fájlként, hanem secretként kell tárolni.

A Python kód most már tud:

- fájlútvonalból olvasni (`GOOGLE_SERVICE_ACCOUNT_JSON`)
- vagy nyers JSON stringből (`GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT`)

Ez jó átmeneti állapot lokális és szerverless használatra is.

## WordPress plugin oldalon mi változik

Majd csak ez:

- `endpoint_url` mező a localhost helyett a Cloudflare Worker publikus URL-je lesz

Minden más:

- `pipeline_id`
- payload mapping
- shared secret

maradhat ugyanebben a logikában.

## Megvalósult állapot (2026-07-14)

1. Elkészült a Worker-kompatibilis pipeline config.
2. Elkészült a hitelesített webhook endpoint és a Google Sheets közvetlen írása.
3. Lefutott a helyi smoke teszt és a Google Sheets írási folyamat szimulációja.
4. A Cloudflare Workeren secretként be van állítva a webhook titok, a Google service account JSON és a pipeline config.
5. Publikus endpoint: `https://budaitancklub-registration-webhook.zsolt-3bf.workers.dev/webhooks/gravity-forms`
6. A WordPress pluginban már ez a publikus endpoint szerepel.
