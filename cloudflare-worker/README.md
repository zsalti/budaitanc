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
   npx wrangler secret put PAYMENT_IMPORT_TOKEN
   npx wrangler secret put EMAIL_ADMIN_TOKEN
   npx wrangler secret put BREVO_API_KEY
   npx wrangler secret put BREVO_SENDER_EMAIL
   npx wrangler secret put BREVO_SENDER_NAME
   npx wrangler secret put BREVO_REPLY_TO_EMAIL
   npx wrangler secret put BREVO_WEBHOOK_SECRET
   ```

   A másodikhoz a Google service account JSON fájl **teljes tartalma** kell,
   egyetlen JSON-ként (nem a fájl útvonala).

3. Add meg a pipeline-beállítást Worker változóként. A valódi értékhez a
   `pipelines.json.example` tartalmát használd, és a `replace_me` sort hagyd ki
   vagy töltsd ki később.

   ```bash
   npx wrangler secret put PIPELINES_CONFIG_JSON
   ```

   A banki Excelhez külön forrás-beállítás is kell. A
   `payments-source.json.example` alapján készítsd el, majd secretként add meg:

   ```bash
   npx wrangler secret put PAYMENTS_SOURCE_CONFIG_JSON
   ```

   Két forrásmód lehetséges:

   - `drive_file_id` — mindig ugyanaz a Google Drive-fájl; a friss banki
     kivonatot ebbe a fájlba kell feltölteni/cserélni.
   - `drive_folder_id` — egy kijelölt Drive-mappa; a Worker a mappa
     legfrissebb (`modifiedTime` szerinti) `.xlsx` fájlját tölti le, tehát a
     kezelő egyszerűen bedobja az új exportot a mappába, nem kell fix fájlt
     felülírni. Ha mindkét mező szerepel, a `drive_file_id` élvez elsőbbséget.

   Mindkét esetben a fájlt (vagy a mappát) oszd meg **olvasóként** a
   `budaitancklub-reg@budaitancklub.iam.gserviceaccount.com` címmel, és a
   Google Cloud projektben a Google Drive API is legyen engedélyezve.

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
CSV-rekordot a fő Sheet mellett a munkatársi Sheetbe is beír. A teljes
szinkron az `A:H` mezőkön felül az `I. féléves tandíjfizetés dátuma`, a
`II. féléves tandíj befizetés dátuma` és az `Egyéb megjegyzés` mezőt is átviszi.
Ha ezek még hiányoznak a munkatársi lap fejlécéből, létrehozza őket; a többi kézi, pénzügyi és
megjegyzés-oszlop érintetlen marad.

A fő Sheethez kötött Apps Script a `Budai Tánc → Munkatársi Sheet
szinkronizálása` menüponttal indít teljes egyeztetést. A kód az
`../apps-script/master-sheet-sync.gs` fájlban van. A token egyszeri megadása
a Script Properties-ben történik. A szinkron fizikailag törli a munkatársi
Sheetből azokat az azonosítóval ellátott sorokat, amelyek már nincsenek a fő
Sheetben. Minden futáskor `Közlemény` azonosító alapján frissíti a már létező
sorok mindkét fizetési dátumát és az `Egyéb megjegyzés` értékét is, ezért a
jelentkezés után később rögzített befizetések is átkerülnek, új sor létrehozása
nélkül.

## Befizetések érkeztetése

A fő Sheethez kötött Apps Scriptben a `Budai Tánc → Befizetések érkeztetése`
menüpont indítja a feldolgozást. Az első futás előtt a `Budai Tánc →
Befizetési token beállítása` menüpontban egyszer meg kell adni a
`PAYMENT_IMPORT_TOKEN` értékét.

A Worker a megadott Drive-fájlból (vagy -mappa legfrissebb fájljából) olvassa
a banki `.xlsx`-et, majd:

- a közleményben levő pontos, 1–7 számjegyes `Közlemény` azonosítót
  automatikusan párosítja;
- a fő Sheet `I. féléves tandíjfizetés dátuma` oszlopába csak üres fizetési dátum esetén ír (jelenleg K oszlop); a J oszlop az elvárt `I. féléves tandíj` összege;
- minden beolvasott tételt a `Befizetések napló` fülön őriz meg;
- ha a közlemény egy jóváhagyott (`Feldolgozható`) és egyértelmű
  `Közlemény eltérések` korrekcióval egyezik, a **valódi** közleményhez
  könyvel; a naplóban a párosított kód a valódi, a jelöltek oszlop az
  eredetit is megőrzi, a státusz `Könyvelve javított közleménnyel`;
- ha a közleményből több létező azonosító is kiolvasható (`Többértelmű`), és
  a feladó vezetékneve pontosan egy jelölt növendékének/szülőjének nevével
  egyezik, ahhoz könyvel, `Könyvelve névvel megerősítve` státusszal;
- minden más hibás, hiányzó, korrekció nélküli vagy továbbra is
  többértelmű tételt a `Függő befizetések` fülre tesz, a javaslatok mezőben a
  könyvelési dátummal kiegészítve;
- a `Kézzel hozzárendelt közlemény` oszlopba írt érvényes azonosítót a
  következő futáskor könyveli le.

**Inkrementális import.** A banki export mindig kumulatív (a korábbi sorokat
is tartalmazza). A `Befizetés import állapot` fül egysoros vízjelet tart
(utolsó importált sorszám, az utolsó 1–2 sor ujjlenyomata). Ha az új fájl
teteje pontosan illeszkedik az előzőhöz (append-only), a Worker csak a
korábbinál későbbi sorokat dolgozza fel — ez azt is jelenti, hogy egy
tranzakcióazonosító nélküli, de tartalmilag a korábbival véletlenül azonos
**új** sor sem vész el (pozíció alapján, nem tartalmi ujjlenyomat alapján dönt
újdonságról). Ha a fájl eleje nem egyezik (átrendezve/szerkesztve), a Worker
visszaáll a teljes, `Befizetések napló`-alapú tartalom-ujjlenyomat dedupra —
ez a `Befizetések feldolgozva` visszajelzésben `state_reset` jelzést kap.

A banki fájl tényleges fejlécét a `payments-source.json.example` `columns`
leképezésében lehet hozzáigazítani. A repositoryban levő
`test-fixtures/minta-banki-kivonat.xlsx` teljesen anonim, és az elvárt
munkalap-/oszlopstruktúrát szemlélteti.

## Díjszámítás és e-mail-piszkozatok

A Worker a `Tanfolyamok` fül strukturált órarendjéből, díjsávjaiból és
kivételeiből számol. Ez az egyetlen kézzel karbantartott tanfolyamforrás: egy
heti alkalom egy sor, a többalkalmas tanfolyamok sorai ugyanazt a tanfolyamkulcsot
használják. A rejtett `Automata kalk` fül csak automatikus kompatibilitási tükör,
nem szerkesztendő. Új webhook/CSV rekord után a Worker automatikusan frissíti a
fő Sheet AH:AR automatizálási mezőit és az `E-mail kimenet` piszkozatát.

- A próbaóra díja fix 2600 Ft, és a `Próbaóra dátuma` szerinti órát ellenőrzi.
- Tanfolyamnál a jelentkezés és a kért kezdés közül a későbbi naptól keresi az
  első órát; ennek napja választ díjsávot.
- A J vagy AC díjmezőt csak egyértelmű, küldhető számítás írja.
- Pilates, Berczik, jóváírás, eltérő óraszám, hibás kedvezmény vagy hiányzó
  adat `KÉZI ELBÍRÁLÁS` státuszt kap.
- Első használatkor a `Budai Tánc → E-mail lapok inicializálása` menüpont
  létrehozza/frissíti az `E-mail kimenet`, `E-mail beállítások` és `E-mail
  eseménynapló` lapokat, valamint a két keresztnév-segédoszlop fejlécét.
- Az `E-mail kimenet` a teljes tárgyat, szöveges és HTML-változatot mutatja.
  Szerkeszthető, de minden tartalmi/sablonparaméter-módosítás törli a korábbi
  jóváhagyást. Küldés csak a `Jóváhagyva` checkbox után,
  a `Budai Tánc → Jóváhagyott e-mailek küldése` menüből történik.
- A küldés kizárólag a már jóváhagyott, meglévő sort küldi; nem frissít és nem
  generál piszkozatot. A piszkozatfrissítés ettől külön művelet.
- Egy jelentkezés–esemény–időszak küldési szándékhoz csak egy sor tartozhat.
  Címzetteltérés, duplikált szándék vagy a segédnévmező és a kanonikus forrás
  eltérése esetén a Worker nem ír új sort: `KÉZI ELBÍRÁLÁS` állapotban megáll.
- A `Manuálisan elküldve` checkbox rögzíti a kézzel kiküldött levelet,
  időbélyeget és kezelőt ír, zöldre színezi a sort, és kizárja azt a Brevo
  küldési köréből. A jelölés visszavonásakor az előző státusz áll vissza.
- A jóváhagyási revízióhash a címzettet, tárgyat, mindkét levéltörzset,
  sablonazonosítót és paramétereket együtt rögzíti. A küldési kulcsból képzett
  Brevo `Idempotency-Key` és a tartós
  `JÓVÁHAGYVA` feldolgozási jelző védi a sort a megszakadt vagy ismételt
  küldéstől.
- A `BREVO FOGADTA` csak API-átvételt jelent. A `KÉZBESÍTVE` állapotot külön,
  titkos fejléccel védett Brevo webhook írja. A hard bounce, blokkolt,
  érvénytelen vagy letiltott cím a későbbi automatikus küldést is megállítja.
- A webhook csak egyetlen, egyidejű `Brevo messageId` és címzett egyezésénél
  frissít e-mail-sort. Hiányzó vagy többértelmű egyezésnél csak karanténos
  eseménynapló-bejegyzést készít.
- A Brevo kulcs kizárólag Worker secret lehet. A beszélgetésben vagy más
  nyilvános helyen megjelent kulcsot vissza kell vonni, és új kulcsot kell
  létrehozni.

### Hibásan kiküldött közlemények

A `Budai Tánc → Hibás közlemények összevezetése` menüpont kizárólag
ellenőrzőlistát készít; nem frissít e-mail-piszkozatot, nem változtat meg régi
e-mail-sort és nem küld levelet. A `Közlemény eltérések` fülön minden ilyen
esethez megjelenik a hibásan kiküldött közlemény, a levél címzettje és — ha az
e-mail cím a `TAGOK I FÉLÉV` forrásban pontosan egy rekordhoz tartozik — a
címzett valódi közleménye.

Az `Feldolgozható` jelölőt csak emberi ellenőrzés után szabad bejelölni. A
banki befizetés-import ezt a listát olvassa: ha egy adott hibás közleményhez
pontosan egy jóváhagyott, létező regisztrációra mutató valódi közlemény
tartozik, az importer automatikusan a valódihoz könyvel (`Könyvelve javított
közleménnyel` státusz). Ha ugyanahhoz a hibás kódhoz több jóváhagyott valódi
közlemény is tartozik, vagy a sor nincs `Feldolgozható`-ra jelölve, az
importer nem könyvel automatikusan — a tétel a `Függő befizetések` fülre
kerül.

Az Apps Script első használatakor a `Budai Tánc → E-mail token beállítása`
menüben az `EMAIL_ADMIN_TOKEN` értékét kell megadni. A `BREVO_API_KEY` nem
kerül az Apps Scriptbe.

## Brevo-sablonok és webhook

A repository hat verziózott, mobilbarát tranzakciós sablon forrását tartja.
Az alábbi parancsok alapból csak olvasnak vagy tervet írnak ki; egyik sem küld
e-mailt.

```bash
# Ellenőrzött feladók, tranzakciós sablonok és webhookok listázása
read -s 'BREVO_API_KEY?Brevo API-kulcs: '; export BREVO_API_KEY; echo
npm run brevo:inspect

# Egy meglévő kiinduló sablon teljes metaadatának és HTML-jének kiolvasása
npm run brevo:inspect -- --template-id=123

# A 6 tervezett módosítás helyi előnézete (Brevo-írás nélkül)
npm run brevo:templates

# A hat forrásazonos, dummy adatokkal kitöltött helyi HTML-előnézete
npm run brevo:preview
```

Az előnézetek a `previews/` mappába kerülnek (git-ignorált). A parancs megáll,
ha akár egyetlen Brevo-változó feloldatlan marad. A Brevo API-s előnézethez a
`POST /v3/smtp/template/preview` endpoint használható `templateId` és `params`
mezőkkel; ez egyes fiókoknál csak létező contacttal működik, ezért a helyi
renderer a reprodukálható ellenőrzési alap.

Az első tényleges szinkron szándékosan inaktív sablonokat hoz létre vagy
frissít. Meglévő sablont csak explicit `BREVO_TEMPLATE_IDS_JSON` leképezés,
vagy a saját `budai-tancklub:<SABLONKULCS>` tag alapján módosít.

```bash
export BREVO_SENDER_EMAIL='a-brevoban-ellenorzott-felado@example.com'
export BREVO_SENDER_NAME='Budai Táncklub'
export BREVO_REPLY_TO_EMAIL='a-jovahagyott-valaszcim@example.com'
npm run brevo:templates -- --execute
```

A parancs visszaírható `TEMPLATE_*` értékeket ad az `E-mail beállítások`
laphoz. A hat sablon aktiválása csak külön, vizuális/tartalmi ellenőrzés után:

```bash
npm run brevo:templates -- --execute --activate
```

### Kontrollált Gmail-tesztek

A tesztküldő parancs csak a rögzített `zsalti.r+...@gmail.com` címekre enged
küldést, és alapból dry-run. A tíz minta lefedi a két helyszínt, a szülő/felnőtt
címzettet, a próbaóra/beiratkozás eseményt és a két befizetés-visszaigazolást.

```bash
npm run brevo:control-tests
npm run brevo:control-tests -- --execute
```

A webhook-szinkron szintén dry-run alapú. A Workerben és a Brevo által küldött
egyedi fejlécben ugyanaz a hosszú, véletlen `BREVO_WEBHOOK_SECRET` szerepeljen.

```bash
export BREVO_WEBHOOK_URL='https://...workers.dev/webhooks/brevo'
read -s 'BREVO_WEBHOOK_SECRET?Webhook titok: '; export BREVO_WEBHOOK_SECRET; echo
npm run brevo:webhook

# Csak a terv ellenőrzése után:
npm run brevo:webhook -- --execute
```

A kulcsokat ne add meg parancssori argumentumként és ne írd fájlba. A fenti
helykitöltők dokumentációs példák; az éles Worker-értékekhez a `wrangler
secret put` interaktív parancsot használd.

## Tesztelés

```bash
npm run check
npm run test:fee
npm run test:email
npm run test:smoke
npm run generate:payment-fixture
```

A `test-fixtures/dami-registration.csv` egy teljes, személyes adatot nem
tartalmazó dummy export. A smoke teszt ellenőrzi az új rekord beszúrását, az
azonos rekord frissítését, a J:N mezők megőrzését, a hibás fejléc elutasítását,
a próbaóradátum mappelését, a 10 e-mail-forgatókönyvet, a revízióhoz kötött
jóváhagyást, az idempotens Brevo-kérést és a kézbesítési webhookot. Production smoke teszt esetén a
`TEST-CODEX-20260723-001` és `TEST-WEBHOOK-001` azonosítókat a végén célzottan
ellenőrizni és törölni kell.

### Incidens forrásaudit (csak olvasás)

Az alábbi parancs kizárólag kiolvassa a fő Sheetet, az `E-mail kimenet` és az
`E-mail eseménynapló` lapot. Nem módosít Google Sheetet és nem küld e-mailt;
a jelentésben csak sorszámok és bejegyzésazonosítók szerepelnek.

```bash
python3 scripts/audit_incident.py --output reports/incident-audit-YYYY-MM-DD.json
```

A teljes Gravity Forms-exporttal ugyanez a production díj- és e-mail-logikát
is lefuttatja, és személyes adat nélküli helyreállítási besorolást tesz a
riportba:

```bash
python3 scripts/audit_incident.py \
  --gravity-csv /abszolút/út/gravity-forms-export.csv \
  --output reports/incident-source-reconciliation-YYYY-MM-DD.json
```

### Fagyasztott helyreállítási csomag

A csomagkészítő nem ír Google Sheetet és nem küld e-mailt. Két egymást
követő, azonos read-only olvasásból készít snapshotot, majd létrehozza a
kanonikus fő-Sheet- és E-mail-kimenet-rekonstrukciót. A személyes adatot
tartalmazó CSV-k a gitignored `scratch/` alatt, csak a tulajdonos számára
olvasható jogosultsággal készülnek; a `reports/` manifest nem tartalmaz nevet
vagy e-mail-címet.

```bash
python3 scripts/build_recovery_bundle.py \
  --gravity-csv /abszolút/út/gravity-forms-export.csv \
  --scratch-dir scratch/incident-recovery-YYYY-MM-DD \
  --manifest reports/incident-reconstruction-manifest-YYYY-MM-DD.json
```

Az idempotencia- és rollback-próbákat mindig a fagyasztott snapshoton kell
futtatni, mert a Brevo webhook az operátori műveletektől függetlenül is
érkezhet:

```bash
python3 scripts/build_recovery_bundle.py --offline \
  --gravity-csv /abszolút/út/gravity-forms-export.csv \
  --scratch-dir scratch/incident-recovery-YYYY-MM-DD \
  --manifest reports/incident-reconstruction-manifest-YYYY-MM-DD.json
```

Az élő migrációhoz ez a csomag csak bemenet: automatikus éles írást
szándékosan nem tartalmaz.

Külön, service-account tulajdonú Google Sheet migrációs próba (az éles
spreadsheetet nem írja, e-mailt nem küld):

```bash
python3 scripts/rehearse_recovery_sheet.py \
  --scratch-dir scratch/incident-recovery-YYYY-MM-DD \
  --report reports/incident-sheet-rehearsal-YYYY-MM-DD.json \
  --create-staging-sheet
```

Ha a service account nem hozhat létre saját fájlt, előbb készíts Drive-másolatot
az éles spreadsheetből, oszd meg a service accounttal szerkesztőként, majd a
fenti utolsó kapcsoló helyett add meg a másolat azonosítóját:

```bash
--staging-spreadsheet-id GOOGLE_SHEET_COPY_ID
```

## Új űrlap / új folyamat

Minden új Gravity Forms űrlaphoz:

1. a WordPress plugin `BUDAI_TANC_WEBHOOK_PIPELINES` listájába új elem kerül;
2. itt a `PIPELINES_CONFIG_JSON`-be ugyanazzal a `pipeline_id`-val új elem kerül;
3. ha eltérő mezőstruktúrájú (például verseny), a Workerben új adaptert kell
   hozzáadni a `payloadToRow` függvényhez.

Az azonos `pipeline_id` kapcsolja össze a WordPress űrlapot a cél Google
Sheettel.
