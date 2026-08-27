# Regisztráció-helyreállítás delivery manager

*Utolsó frissítés: 2026-08-27 23:41 CEST*

## Tényalapú állapot

A biztonságosan automatizálható helyreállítási munka productionben fut. A Worker aktuális éles verziója `28a644a5-5a44-480e-bd3b-b8f0ac09c419`; a `/healthz` végpont `200`-at adott, a befizetési és teljes munkatársi szinkron útvonalak `410 disabled` válaszúak maradtak.

A legutóbbi, csak olvasó production-audit 195 fő Sheet-sort, 195 e-mail-kimeneti sort és 89 e-mail-eseményt talált. Duplikált ID, küldési kulcs, küldési szándék és címzettazonossági hiba nincs. Az események bontása: 44 kézbesített, 44 request és 1 puha visszapattanás. Nyolc aktív e-mail-jóváhagyás továbbra is megmaradt; ezekhez ez a manager nem ír és nem indít küldést.

## Lezárt technikai tételek

- A Szirányi/Modern tánc névváltozatok élő konfigurációval történő besorolása: 4/4 küldhető, 0 ismeretlen tanfolyam vagy hiányzó órarend.
- A szerdai művészi torna díjregressziója: a jelenlegi éles form-érték a régi `Heti alkalom = 2` beállítás ellenére egy kijelölt szerdai idősávnál `1x45` díjkategóriát ad; ezt célzott automatikus teszt rögzíti.
- A read-only helyreállítási besorolás PII-mentes `fee_category` mezőt is ad, ezért a következő konfiguráció-audit díjkategóriánként bizonyítható.
- A teljes Worker-regresszió, a Python recovery-bundle teszt, az Apps Script helyi menü-/endpoint-szerződésvizsgálata és a Worker dry-run zöld.
- A bound Apps Script helyi forrása csak explicit ID-listával kér piszkozatot, a küldéshez külön `YES/NO` emberi megerősítés kell, közvetlen Gmail-küldés, befizetés-import és teljes szinkron nincs benne.

## Valódi külső kapuk

1. **Bound Apps Script kiadásának technikai visszaolvasása:** nincs ehhez a Sheethez tartozó Apps Script-projektazonosító vagy `clasp`-belépés. A Drive-kapcsolat a Sheetet látja, Apps Script-projektet nem; a böngészős vezérlés ebben a sessionben nem elérhető. Zsolt korábbi, megerősített végrehajtása szerint a friss bound script 29 levelet küldött, ebből kb. 22 kézbesült. Ezt nem ismételjük meg.
2. **A fennmaradó 8 jóváhagyás:** csak emberi felülvizsgálat döntheti el, megtartandók vagy visszavonandók; a manager nem küld kontrolllevelet és nem módosítja őket.
3. **Tracker `done`:** a jelenlegi repo-módosítások még nincsenek commitolva. A technikai munka `in-review`, a lezárás commit/emberi elfogadás után történhet.

**Tulajdonos:** Zsolt — a jóváhagyási és bound Apps Script-kapu kezelője.  
**Következő lépés:** a fenti két emberi kapu kezelése után a commitot lezáró hivatkozással kell elkészíteni.  
**Lezárási feltétel:** a releváns módosítás commitolva, az Apps Script éles kiadása visszaigazolt vagy hitelesen már teljesített, és nincs ismeretlenül nyitott tracker-tétel.
