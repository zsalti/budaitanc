# Jelentkezés–e-mail célarchitektúra: döntési javaslat

**Állapot:** döntésre előkészítve — ez a dokumentum nem változtat production rendszert.  
**Kapcsolódó helyreállítás:** `registration-email-recovery.md`, B szál

## Javaslat röviden

A következő fejlesztési ciklusban a **Cloudflare Worker + D1 kanonikus adatminta** legyen a cél. A Google Sheet maradjon emberi munkanézet és jóváhagyási felület, de ne legyen többé az a hely, ahol egy jelentkezés, egy küldési szándék vagy egy kézbesítési esemény végleges igazsága eldől.

Ez ad elég erős egyediség-, idempotencia- és auditgaranciát anélkül, hogy most egy teljesen új, nehézkes ügyviteli rendszert építenénk. A jelenlegi, biztonságos CSV-import/e-mail útvonal marad üzemben az átállás alatt. A banki folyamat és a teljes munkatársi szinkron csak az új írási kapuk után térhet vissza.

Nem javasolt sem a jelenlegi Sheetet tovább terhelni üzleti adatbázisként, sem egyetlen nagy átállással lecserélni minden kezelői folyamatot. Mindkettő feleslegesen jó eséllyel visszahozná azt a fajta „látszólag rendben, közben átcsúszott három sor” problémát, amelyből most épp kifelé megyünk.

## Kiindulópont és döntési szempontok

A helyreállítás bebizonyította, hogy az append-only import, a tervhash, a küldési kulcs és a manuális jóváhagyás működő védőkorlát. Ugyanakkor a Sheet sorai egyszerre jelentenek forrásadatot, számítási eredményt, kézi munkafelületet és e-mail állapotot. Ez a négy szerep egy helyen túl sok felelősség még egy jól nevelt táblázatnak is.

A célarchitektúrának az alábbiakat kell teljesítenie:

- egy Gravity Forms ID-hoz pontosan egy kanonikus jelentkezés tartozzon;
- egy jelentkezés–esemény–időszak küldési szándék csak egyszer jöhessen létre;
- a küldési, Brevo-webhook és kezelői események utólag hozzáfűzhetők, de ne legyenek csendben átírhatók;
- a Sheetből végzett kézi szerkesztés ne kerülhesse meg a szerveroldali integritási kaput;
- visszaállítható legyen egy ismert, időbélyegzett állapot, és az eltérés mérhető legyen;
- legyen külön teszt- és production-környezet, valamint egyértelmű release-napló.

## Három reális út

### 1. A Google Sheet marad a kanonikus tároló, szigorúbb Worker-kapuval

**Mit jelent:** A jelenlegi Worker marad az összes írás kizárólagos útja. Külön import- és e-mail-eseménynapló lap készül, a kanonikus főlapon nincs rendezés, a Sheet csak jóváhagyási nézetként szolgál. A Worker minden írás előtt visszaolvas és hash-el.

**Előny:** A legkisebb átállás; a kezelők megszokott felületen dolgoznak. Becsült fejlesztési költség: 3–6 fejlesztői nap.

**Kockázat:** A Sheet továbbra is gyenge tranzakciós tároló. Két Worker-isolate közötti valódi, tartós versenyhelyzetet és minden emberi API-s módosítást nehéz azonos erővel kezelni. A rollback nagy adatmennyiségnél lassú és költséges marad.

**Mikor elég:** Rövid, 1–2 hónapos átmenetként, amíg a jelenlegi stabil működés megfigyelhető. Tartós célként nem ajánlott.

### 2. Worker + Cloudflare D1 kanonikus adat és outbox — ajánlott

**Mit jelent:** A Worker egy D1-adatbázisba írja a `registrations`, `email_intents`, `email_events`, `imports` és `audit_events` rekordokat. A Sheet egy irányú, újraépíthető projekció: a kezelő ott nézi át a sort és jelzi a jóváhagyást, a Worker pedig ellenőrzötten visszaolvassa a jóváhagyási kérelmet. Brevo-küldés az `email_intents` outboxából indul, a webhook csak eseményt fűz hozzá.

**Kötelező korlátok:**

- `registrations.gravity_entry_id` egyedi index;
- `email_intents(registration_id, event_type, period_key)` egyedi index;
- minden küldéshez stabil idempotency key;
- állapotátmenet csak előre, naplózott esemény alapján;
- importterv, CSV-hash, előtte/utána snapshot és backup-azonosító auditálva;
- a Sheet-projekció eltérése olvasható jelentést ad, de nem írja vissza magától a kanonikus adatot.

**Előny:** A jelenlegi Cloudflare- és Brevo-integráció közelében marad, de adatbázis-szintű egyediséget, atomikus tranzakciót és tiszta idempotenciát kap. A Sheet továbbra is kényelmes ügyviteli nézet. Becsült fejlesztési költség: 2–3 hét, fokozatos bevezetéssel.

**Kockázat:** Sémamigrációt, mentési/restore-próbát és külön staging D1-et kell fegyelmezetten működtetni. A Sheet-jóváhagyás és a D1-állapot közötti UX-et meg kell tervezni, nem elég rá egy újabb checkboxot tenni.

**Miért ez a javaslat:** Arányos a rendszer méretével és a már működő Workerrel; megoldja a legfontosabb incidens-okokat anélkül, hogy a napi munka felületét egyik napról a másikra elvenné.

### 3. Külső, menedzselt PostgreSQL + admin felület

**Mit jelent:** Supabase/Neon-szerű PostgreSQL adatbázis, külön admin alkalmazás, a Sheet csak export vagy átmeneti riport.

**Előny:** Erős adatmodell, jó riportolás, későbbi pénzügyi és jogosultsági bővítéshez a legtágabb tér. Becsült fejlesztési költség: 4–6 hét, plusz folyamatos szolgáltatási és üzemeltetési költség.

**Kockázat:** A jelenlegi működéshez képest nagy felület- és folyamatváltás. Az átállás idején két rendszer adateltérése valós veszély; a kezelőknek új adminfelületet kell megtanulniuk.

**Mikor indokolt:** Ha a jelentkezés, befizetés, számlázás és több munkatárs jogosultságkezelése egyazon rendszerben, növekvő volumen mellett válik üzleti igénnyé. Most túl nagy ugrás lenne.

## Javasolt átállási sorrend

1. **Stabilizálás:** a jelenlegi helyreállítási kapu marad aktív; a nyitott e-mail-jóváhagyások külön emberi döntést kapnak. A Worker-változások csak teszt és deploy-napló után kerülnek productionbe.
2. **Séma és staging:** D1 staging adatbázis, migrációs fájlok, anonim fixture, restore-próba. Sem Gravity Forms, sem Brevo nem ír még D1 productionbe.
3. **Árnyék-import:** egy teljes CSV-import a jelenlegi Worker-útvonal és D1 staging között csak összehasonlításra fut. Egyezés: ID-k, kiválasztott forrásmezők, e-mail-szándékok és darabszámok.
4. **Csak olvasott projekció:** D1-ből épül egy külön Sheet-nézet; a régi főlappal napi eltérésriport készül. Írási jog még nincs átkapcsolva.
5. **Írási váltás importonként:** az új CSV-import először D1-tranzakciót ír, majd frissíti a Sheet-projekciót. A rollback a korábbi import tranzakciójának egyértelmű visszavonása, nem kézi sorvadászat.
6. **E-mail outbox:** csak stabil import után vált át a piszkozat/küldés D1-es `email_intents` állapotgépre. A Brevo webhook eseményappend marad.
7. **Későbbi folyamatok:** a befizetés-import és munkatársi szinkron csak külön döntés, teszt és ugyanilyen outbox/napló mellett tér vissza.

## Release és üzemeltetési minimum

- külön `staging` és `production` konfiguráció, külön titkokkal és külön Sheet/D1 célokkal;
- migration fájl, rollback-leírás és tesztadat minden sémaváltáshoz;
- minden deployhoz git SHA, konfigurációs cél és automatizált teszteredmény kerül a release-naplóba;
- napi titkosított adatbázis-export vagy provider-backup, heti visszaállítási próba;
- riasztás: ismétlődő import, duplikációs kísérlet, sikertelen webhook, küldési hibaarány és Sheet-projekció eltérés;
- személyes adatot nem tartalmazó auditjelentés és külön, hozzáférés-védett operátori napló.

## Döntési kapu

**Tulajdonos:** Zsolt, a kezelői folyamat és a költségkeret döntője.  
**Következő lépés:** a D1-es út elfogadása után készül egy külön, írásmentes technikai terv: séma, import-összevetés, Sheet-projekció és rollback-próba.  
**Lezárási feltétel:** a célarchitektúra és az átállási sorrend jóváhagyott; az első D1-es implementáció csak ezt követően indul.
