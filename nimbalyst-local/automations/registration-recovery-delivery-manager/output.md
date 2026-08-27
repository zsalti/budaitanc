# Regisztráció-helyreállítás delivery manager

*Utolsó frissítés: 2026-08-28 00:47 CEST*

## Tényalapú állapot

A biztonságosan automatizálható helyreállítási munka productionben fut. A Worker aktuális éles verziója `55fe4676-7eb6-4f9c-9a2c-9ca59a0267d3`; a `/healthz` végpont `200`-at adott. A `/sync/` útvonal ismét aktív, de hibás tokennel `404`-et ad, és az előnézet minden írás előtt külön tokenhez kötött.

A legutóbbi, csak olvasó production-audit 195 fő Sheet-sort, 195 e-mail-kimeneti sort és 90 e-mail-eseményt talált. Duplikált ID, küldési kulcs, küldési szándék és címzettazonossági hiba nincs. Az események bontása: 44 kézbesített, 45 request és 1 puha visszapattanás. Nyolc aktív e-mail-jóváhagyás továbbra is megmaradt; ezekhez ez a manager nem ír és nem indít küldést.

A hozzáadott 76-soros Gravity Forms export alapján az automatikus import előnézetének jelöltje két, a fő Sheetből hiányzó ID: `1936` és `1951`. Két már létező ID forrásmezői eltérnek; a rendszer ezeket nem frissítheti. Az import tehát kézi ID-lista nélkül, kizárólag az új ID-kat választaná ki, de az éles végrehajtásra még nem került sor, mert friss import-előnézet, tervhash és Drive-backup kell hozzá.

## Lezárt technikai tételek

- A Szirányi/Modern tánc névváltozatok élő konfigurációval történő besorolása: 4/4 küldhető, 0 ismeretlen tanfolyam vagy hiányzó órarend.
- A szerdai művészi torna díjregressziója: a jelenlegi éles form-érték a régi `Heti alkalom = 2` beállítás ellenére egy kijelölt szerdai idősávnál `1x45` díjkategóriát ad; ezt célzott automatikus teszt rögzíti.
- A read-only helyreállítási besorolás PII-mentes `fee_category` mezőt is ad, ezért a következő konfiguráció-audit díjkategóriánként bizonyítható.
- A teljes Worker-regresszió, a Python recovery-bundle teszt, az Apps Script helyi menü-/endpoint-szerződésvizsgálata és a Worker dry-run zöld.
- Az import eredményoldala automatikusan kiválasztott új ID-khoz ad rövid életű piszkozatjogosultságot; a bound Apps Script nem kér kézi ID-listát. A küldéshez továbbra is külön `YES/NO` emberi megerősítés kell, közvetlen Gmail-küldés és befizetés-import nincs benne.
- A munkatársi Sheet-szinkron Worker-oldalon írásmentes előnézettel, változatlan tervhash-sel, friss Drive-backuppal, külön törlési megerősítéssel és írás utáni visszaolvasással működik. A production service-account és `SYNC_ADMIN_TOKEN` titok be van állítva, de a tokent nem lehet kiolvasni a Cloudflare-ből.

## Valódi külső kapuk

1. **Bound Apps Script kiadása és előnézete:** nincs ehhez a Sheethez tartozó Apps Script-projektazonosító vagy `clasp`-belépés, és az elérhető böngészős kapcsolat üres volt. A Worker deploy ezért nem frissíthette a bound menüt és nem tudott valódi `preview`-t indítani. A teendő technikai, nem üzleti döntés: a [master-sheet-sync.gs](../../../apps-script/master-sheet-sync.gs) kiadása, `SYNC_ADMIN_TOKEN` Script Property beállítása, majd a menüből írásmentes előnézet.
2. **A két source-only ID éles importja:** a Worker ezt automatikusan kiválasztja, de az írás előtt friss import-előnézet, tervhash és Drive-backup szükséges. A manager nem kezeli kézi ID-listával és nem ír közvetlenül Sheetbe.
3. **A fennmaradó 8 jóváhagyás:** csak emberi felülvizsgálat döntheti el, megtartandók vagy visszavonandók; a manager nem küld kontrolllevelet és nem módosítja őket.

**Tulajdonos:** Zsolt — a jóváhagyási és bound Apps Script-kapu kezelője.
**Következő lépés:** a helyi Worker/Apps Script módosítások commitja és a bound Apps Script fent leírt kiadása.
**Lezárási feltétel:** a releváns módosítás commitolva, az Apps Script éles kiadása visszaigazolt, és nincs ismeretlenül nyitott tracker-tétel. A D1-célarchitektúra külön döntési tétel marad.
