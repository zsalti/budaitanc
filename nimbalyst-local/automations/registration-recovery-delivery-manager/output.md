# Regisztráció-helyreállítás delivery manager

*Utolsó frissítés: 2026-08-28 10:08 CEST*

## Tényalapú állapot

A biztonságosan automatizálható helyreállítási munka productionben fut. A Worker aktuális éles verziója `5352b07b-7703-478d-961e-0a8ba2d625d5`; a `/healthz` végpont `200`-at adott. A `/sync/` útvonal ismét aktív, de hibás tokennel `404`-et ad, és az előnézet minden írás előtt külön tokenhez kötött.

A legutóbbi, csak olvasó production-audit 195 fő Sheet-sort, 195 e-mail-kimeneti sort és 90 e-mail-eseményt talált. Duplikált ID, küldési kulcs, küldési szándék és címzettazonossági hiba nincs. Az események bontása: 44 kézbesített, 45 request és 1 puha visszapattanás. Nyolc aktív e-mail-jóváhagyás továbbra is megmaradt; ezekhez ez a manager nem ír és nem indít küldést.

A hozzáadott 76-soros Gravity Forms export alapján az automatikus import előnézetének jelöltje két, a fő Sheetből hiányzó ID: `1936` és `1951`. Két már létező ID forrásmezői eltérnek; a rendszer ezeket nem frissítheti. A normál végrehajtás már nem kér Drive-backup ID-t: a Worker a szerveroldali `IMPORT_BACKUP_SOURCE_CONFIG_JSON` titokban rögzített mappából választja az első friss, séma- és tartalomazonos mentést. A jelenlegi három jelöltből egyik sem alkalmas: a legújabb 1114 perces, és sem a fő-, sem az e-mail-kimeneti hash-e nem egyezik a production pillanatképpel. Ezért az éles import nem indult el és nem írt Sheetbe.

## Lezárt technikai tételek

- A Szirányi/Modern tánc névváltozatok élő konfigurációval történő besorolása: 4/4 küldhető, 0 ismeretlen tanfolyam vagy hiányzó órarend.
- A szerdai művészi torna díjregressziója: a jelenlegi éles form-érték a régi `Heti alkalom = 2` beállítás ellenére egy kijelölt szerdai idősávnál `1x45` díjkategóriát ad; ezt célzott automatikus teszt rögzíti.
- A read-only helyreállítási besorolás PII-mentes `fee_category` mezőt is ad, ezért a következő konfiguráció-audit díjkategóriánként bizonyítható.
- A teljes Worker-regresszió, a Python recovery-bundle teszt, az Apps Script helyi menü-/endpoint-szerződésvizsgálata és a Worker dry-run zöld.
- Az automatikus backup-forrás titka productionben be van állítva. A normál import UI/API nem fogad kézi backup-ID-t; a sérült, régi vagy idegen mappából érkező jelöltet elutasítja, és csak teljes tartalmi egyezés után írhat. A külön vészfelülbírálás API-s admin tokenhez és explicit `emergency` jelöléshez kötött.
- Az import eredményoldala automatikusan kiválasztott új ID-khoz ad rövid életű piszkozatjogosultságot; a bound Apps Script nem kér kézi ID-listát. A küldéshez továbbra is külön `YES/NO` emberi megerősítés kell, közvetlen Gmail-küldés és befizetés-import nincs benne.
- A munkatársi Sheet-szinkron Worker-oldalon írásmentes előnézettel, változatlan tervhash-sel, friss Drive-backuppal, külön törlési megerősítéssel és írás utáni visszaolvasással működik. A production service-account és `SYNC_ADMIN_TOKEN` titok be van állítva, de a tokent nem lehet kiolvasni a Cloudflare-ből.

## Valódi külső kapuk

1. **Bound Apps Script kiadása és előnézete:** nincs ehhez a Sheethez tartozó Apps Script-projektazonosító vagy `clasp`-belépés, és az elérhető böngészős kapcsolat üres volt. A Worker deploy ezért nem frissíthette a bound menüt és nem tudott valódi `preview`-t indítani. A teendő technikai, nem üzleti döntés: a [master-sheet-sync.gs](../../../apps-script/master-sheet-sync.gs) kiadása, `SYNC_ADMIN_TOKEN` Script Property beállítása, majd a menüből írásmentes előnézet.
2. **A két source-only ID éles importja:** a Worker ezt automatikusan kiválasztja, de az írás előtt friss import-előnézet és tervhash kell. A konfigurált mappába most egy felhasználói vagy Shared Drive-os folyamatnak friss, a productionnel tartalomazonos Sheets-másolatot kell tennie. A service account saját Drive-kvótája `storageQuotaExceeded` hibával blokkolta az automatikus másolat létrehozását; a manager nem kerüli ezt meg kézi backup-ID bekérésével és nem ír közvetlenül Sheetbe.
3. **A fennmaradó 8 jóváhagyás:** csak emberi felülvizsgálat döntheti el, megtartandók vagy visszavonandók; a manager nem küld kontrolllevelet és nem módosítja őket.

**Tulajdonos:** Zsolt — a jóváhagyási és bound Apps Script-kapu kezelője.
**Következő lépés:** a Worker automatikus-backup módosításának éles kiadása; utána egy friss, tartalomazonos másolat elhelyezése a konfigurált mappában, majd új import-előnézet.
**Lezárási feltétel:** a releváns módosítás commitolva és élesítve, a bound Apps Script éles kiadása visszaigazolt, és nincs ismeretlenül nyitott tracker-tétel. A D1-célarchitektúra külön döntési tétel marad.
