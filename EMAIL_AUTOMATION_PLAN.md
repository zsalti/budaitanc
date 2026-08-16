# Budai Táncklub – Brevo e-mail-rendszer megvalósítási terve

## Döntés

A Google Sheet és a Cloudflare Worker marad az üzleti logika forrása. A Brevo a jóváhagyott tranzakciós sablonokat tárolja, a Worker pedig sablonazonosítóval és ellenőrzött `params` mezőkkel küld.

Az első, tesztelési szakaszban a Brevóban már ellenőrzött Budai Táncklub Gmail-cím lesz a feladó. A pontos cím nem kerül a kódba: a `BREVO_SENDER_EMAIL` Worker secret/config adja meg. A `budaitancklub@kult2.hu` feladóra és a `kult2.hu` domainhitelesítésre csak a tesztkör lezárása után váltunk.

Hat Brevo-sablon készül:

1. próbaóra – szülő/gondviselő;
2. próbaóra – nagykorú, saját nevében jelentkező;
3. beiratkozás és befizetési információk – szülő/gondviselő;
4. beiratkozás és befizetési információk – nagykorú jelentkező;
5. utalás beérkezett, tagsági kártya – szülő/gondviselő;
6. utalás beérkezett, tagsági kártya – nagykorú jelentkező.

A helyszín nem hoz létre további sablonokat. A Kapás utcai főépület/Berczik/Hajós és az Ágnes terem neve, címe és kiegészítő útbaigazítása külön paraméterként érkezik. Ez a felépítés a leírt 8 próbaóra/beiratkozás kombinációt és a 2 befizetés-visszaigazolást 6 karbantartható sablonnal fedi le.

Nem választjuk a 3 darab, teljes bekezdéseket paraméterként kapó „üres héj” sablont, mert annak tartalma a Brevóban nem lenne érdemben ellenőrizhető. Nem választjuk a 10 külön sablont sem, mert a helyszín miatt feleslegesen dupláznánk a szöveget.

## Tervezett folyamat

1. A Gravity Forms rekord bekerül a fő Sheetbe.
2. A Worker kiszámítja a tanfolyamot, első/próbaórát, díjat, helyszínt és a címzett típusát.
3. A Worker kiválasztja a 6 sablon egyikét, elkészíti a paramétereket, majd a Brevo preview API-val vagy az azzal egyező helyi rendererrel előállítja a végleges tárgyat, szöveges tartalmat és HTML-t.
4. A teljes, végleges levél a jelenlegi mechanizmus szerint először a jelentkezőhöz tartozó `E-mail kimenet` sorba kerül. Feloldatlan merge tag vagy hiányzó kötelező adat esetén a sor nem hagyható jóvá.
5. A kezelő az `E-mail kimenet` lapon ellenőrzi a címzettet és a teljes levelet, majd kézzel bejelöli a `Jóváhagyva` mezőt. **Jóváhagyás nélkül sem teszt-, sem éles levél nem mehet ki.**
6. Küldés előtt a Worker újra ellenőrzi a `source_hash`, `template_id`, `template_version` és `params` értékeket. Bármilyen változás visszavonja a jóváhagyást.
7. A Worker csak a jóváhagyott, változatlan revíziót küldi a Brevo `templateId` + `params` mechanizmusával.
8. A Brevo API-elfogadás és a tényleges kézbesítés külön állapot lesz. A kézbesítést, visszapattanást és blokkolást webhook rögzíti.
9. A banki import által egyértelműen lekönyvelt új befizetés külön `PAYMENT_RECEIVED` e-mail-piszkozatot hoz létre. A függő vagy kézzel még nem párosított befizetés nem generál levelet.

## Címzett- és névlogika

A címzett típusa:

- `ADULT_SELF`: a növendék a jelentkezéskor betöltötte a 18. életévét, és a szülő/gondviselő mező üres vagy a növendék nevével egyezik;
- `PARENT_FOR_CHILD`: a növendék 18 év alatti, és van szülő/gondviselő neve;
- minden ellentmondó vagy hiányos eset `KÉZI ELBÍRÁLÁS`.

A magyar neveket nem lehet minden esetben megbízhatóan szétválasztani pusztán az utolsó szó alapján. Ezért két rejtett, felülírható segédoszlop készül a fő Sheetben:

- `E-mail kapcsolattartó keresztnév`;
- `E-mail növendék keresztnév`.

A Worker első alkalommal javasolt értéket ír, de a kézzel javított értéket nem írja felül. Hiányzó vagy bizonytalan keresztnév nem mehet automatikusan küldésre.

## Központi e-mail-beállítások a Sheetben

Az `E-mail beállítások` fül lesz az emberileg szerkeszthető forrás az alábbiakhoz:

- feladó név: `Budai Táncklub`;
- tesztfeladó: a Brevóban már ellenőrzött Budai Táncklub Gmail-cím;
- későbbi éles feladó és Reply-To: `budaitancklub@kult2.hu`;
- regisztrációs link;
- házirend link;
- bankszámlaszám, kedvezményezett, közlemény-előtag;
- próbaóra fix díja;
- aláírás neve, beosztása, telefonszáma, szervezet- és intézményneve, címe;
- helyszínkódok, teremnevek, címek és megjegyzések;
- a 6 aktív Brevo-sablon azonosítója és forrásverziója.

Az aláírás így központi dinamikus elem: mind a hat sablon ugyanazokat az aláírás-paramétereket használja. Tartalmi változtatáshoz nem kell hat sablont kézzel átírni.

## Brevo-paraméterek

Közös paraméterek:

- `recipient_first_name`
- `student_first_name`
- `student_full_name`
- `course_name`
- `class_datetime`
- `venue_name`
- `venue_address`
- `venue_note`
- `registration_url`
- `house_rules_url`
- `signature_name`
- `signature_title`
- `signature_phone`
- `signature_company`
- `signature_institution`
- `signature_address`

Beiratkozási/befizetési paraméterek:

- `amount_formatted`
- `bank_account_number`
- `beneficiary_name`
- `payment_reference`
- `first_class_datetime`

Auditparaméterek nem kerülnek a levéltörzsbe, de a küldési rekordban megmaradnak:

- `entry_id`
- `event_type`: `TRIAL`, `ENROLLMENT`, `PAYMENT_RECEIVED`
- `audience_type`: `ADULT_SELF`, `PARENT_FOR_CHILD`
- `venue_code`
- `template_id`
- `template_version`
- `source_hash`

## Tesztcímzési szabályok

Minden kontrollált tesztlevél a `zsalti.r+<testscenario>@gmail.com` címre megy. A `<testscenario>` kizárólag kisbetűs, ASCII azonosító, amelyből a levél esete azonnal látszik. A tesztadatok nem valós személyek adatai.

Kötelező tesztcímek:

- `zsalti.r+trial+kapas+parent_for_child@gmail.com`
- `zsalti.r+trial+kapas+adult_self@gmail.com`
- `zsalti.r+trial+agnesterem+parent_for_child@gmail.com`
- `zsalti.r+trial+agnesterem+adult_self@gmail.com`
- `zsalti.r+enrollment+kapas+parent_for_child@gmail.com`
- `zsalti.r+enrollment+kapas+adult_self@gmail.com`
- `zsalti.r+enrollment+agnesterem+parent_for_child@gmail.com`
- `zsalti.r+enrollment+agnesterem+adult_self@gmail.com`
- `zsalti.r+payment_received+parent_for_child@gmail.com`
- `zsalti.r+payment_received+adult_self@gmail.com`

Javasolt dummy nevek:

- szülő/gondviselő: `Teszt Anna`;
- gyermek/növendék: `Teszt Béla`;
- saját nevében jelentkező felnőtt: `Teszt Béla`.

A tesztcím csak a kontrollált tesztkörnyezetben írhatja felül a regisztráció címét. Az `E-mail kimenet` lapon az átirányítás és az eredeti dummy címzett is legyen egyértelműen látható.

## Munkacsomagok

### 1. Szöveg és adatkontraktus

- [x] A kapott instrukcióból elkészíteni a 6 végleges magyar levélváltozatot.
- [x] Egységesíteni a tegezés/magázás, egyes/többes szám és felnőtt/gyerek megfogalmazást.
- [x] Javítani a regisztrációs link hibás Markdown/HTML alakját.
- [x] Rögzíteni a mezőneveket, kötelezőséget és kézi elbírálási szabályokat.
- [ ] Zsolt jóváhagyja a 6 végleges szöveget és a feladói adatokat.

### 2. Google Sheet és Worker-logika

- [x] Létrehozni az `E-mail beállítások` fület és a helyszín/aláírás/pénzügyi konfigurációt.
- [x] Hozzáadni a rejtett, felülírható keresztnév-segédoszlopokat.
- [x] Bevezetni az `ADULT_SELF`, `PARENT_FOR_CHILD` és bizonytalan esetek besorolását.
- [x] A helyszínt kód alapján, nem szabad szöveges részegyezéssel kiválasztani.
- [x] Az e-mail-kulcsot eseménytípussal bővíteni, hogy ugyanahhoz a jelentkezéshez a beiratkozási és befizetési levél is idempotensen létezhessen.
- [x] A banki import után csak az újonnan, egyértelműen könyvelt tételekhez készíteni befizetés-visszaigazoló piszkozatot.
- [x] A Brevo API-kérést `templateId` + `params` formára átállítani.
- [x] Megtartani a jóváhagyási checkboxot, a forráshasht és az idempotenciakulcsot.
- [x] A Brevo-átvételt és a kézbesítést külön állapotként kezelni.

### 3. Forráskezelés és Brevo-sablonok

- [x] A 6 sablon HTML-forrását a repositoryban, verziózva tárolni.
- [x] Egyszerű, mobilbarát, akadálymentes, képek nélkül is teljes leveleket készíteni.
- [x] A Brevo Brand Libraryban a logó és az elsődleges brandszín be van állítva.
- [x] A Brevóban létrejött egy egyszerű kiinduló sablon.
- [ ] API-val azonosítani, hogy a meglévő sablon tranzakciós SMTP-sablonként elérhető-e, és kiolvasni az azonosítóját, editor-típusát és HTML-jét.
- [ ] Ha a meglévő sablon megfelelő, azt használni vizuális alapként a 6 tranzakciós változathoz, a logó és brandszín megtartásával.
- [ ] Ha nem használható tranzakciós alapként, egyszerű, szöveges levélhez hasonló tranzakciós sablont építeni; kis logó, visszafogott brandszínű linkek, egységes aláírás.
- [x] Készíteni egy idempotens sablonszinkron parancsot, amely API-val létrehozza vagy frissíti a 6 Brevo tranzakciós sablont, majd visszaolvassa őket.
- [ ] A sablonokat először inaktívan létrehozni, renderelt előnézettel ellenőrizni, majd külön lépésben aktiválni.
- [ ] A Brevo-sablonazonosítókat visszaírni az `E-mail beállítások` fülre vagy a telepítési konfigurációba.

### 4. Zsolt Brevo- és postafiók-feladatai

- [x] A Budai Táncklub Gmail-címe feladóként be van állítva a Brevóban.
- [ ] Ellenőrizni, hogy a Brevo-fiók tranzakciós e-mail-küldése aktív, és van megfelelő csomag/küldési keret.
- [ ] Létrehozni egy külön, produkciós API-kulcsot, és biztonságosan Cloudflare Worker secretként megadni; a kulcs nem kerülhet Sheetbe, forráskódba vagy chatbe.
- [ ] A pontos Gmail-feladót a Worker `BREVO_SENDER_EMAIL` secretjében beállítani és API-val visszaellenőrizni.
- [ ] Megerősíteni, melyik cím legyen a tesztfázis Reply-To címe, és ki figyeli a beérkező válaszokat.
- [x] A tesztcímzési séma jóváhagyva: `zsalti.r+<testscenario>@gmail.com`.
- [ ] A 10 tesztlevél vizuális és tartalmi jóváhagyása után engedélyezni a korlátozott éles küldést.

Későbbi, külön migrációs munkacsomag:

- [ ] Ellenőrizni/létrehozni a valódi `budaitancklub@kult2.hu` postafiókot.
- [ ] A `Budai Táncklub <budaitancklub@kult2.hu>` feladót ellenőrizni a Brevóban.
- [ ] A `kult2.hu` küldő domaint hitelesíteni Brevo code, DKIM és egyetlen, a meglévő levelezéssel egyeztetett DMARC rekorddal.
- [ ] A tesztelt Gmail-feladóról konfigurációcserével átállni a Kult2 feladóra, majd új kézbesítési próbát futtatni.

### 5. Amit API-val/kódból el tudok végezni

- [ ] Brevo-fiók és Gmail-feladó státuszának ellenőrzése.
- [ ] Feladó létrehozása/frissítése; a postafiókba érkező ellenőrzés emberi jóváhagyása ettől még szükséges lehet.
- [ ] A 6 tranzakciós sablon létrehozása, frissítése, aktiválása, visszaolvasása és paraméteres előnézete.
- [ ] Jóváhagyott tesztlevelek kiküldése.
- [ ] Tranzakciós webhook létrehozása a kézbesítési eseményekhez.
- [x] Cloudflare Worker-kód, tesztek, konfiguráció és dokumentáció elkészítése.
- [ ] A későbbi Kult2-migrációban a Brevo domainhitelesítési rekordjainak kiolvasása és a beállítás utáni státusz ellenőrzése.

Postafiókot vagy DNS-rekordot csak akkor tudok közvetlenül létrehozni/módosítani, ha az adott szolgáltatóhoz külön, engedélyezett hozzáférés van. Enélkül ez Zsolt vagy a `kult2.hu` rendszergazdájának feladata.

### 6. Kézbesítési webhook és hibakezelés

- [x] Védett Worker webhook endpoint készítése Brevo eseményekhez.
- [x] A `request/accepted`, `delivered`, `soft_bounce`, `hard_bounce`, `blocked`, `invalid` állapotok deduplikált rögzítése.
- [x] Ismeretlen vagy bizonytalan eredményt `KÉZI ELLENŐRZÉS` állapotba tenni; automatikus újraküldés nem lehet.
- [x] A Brevo által elfogadott, de webhookkal még nem igazolt levél ne jelenjen meg kézbesítettként.
- [x] Hard bounce, blokkolás vagy érvénytelen cím esetén a további automatikus küldéseket megállítani az adott címre.

### 7. Tesztelés és élesítés

- [x] Unit teszt a 2 címzettípus × 2 helyszín × 2 jelentkezési esemény mind a 8 kombinációjára.
- [x] Unit teszt a befizetés-visszaigazolás mindkét címzettípusára.
- [x] Teszt hiányzó születési dátumra, gondviselőre, e-mailre, keresztnévre, helyszínkódra és sablonazonosítóra.
- [x] Teszt arra, hogy egy befizetés csak egyszer hoz létre levelet.
- [ ] Brevo renderelt preview ellenőrzése mind a 6 sablonhoz dummy adatokkal.
- [ ] Külön tesztjóváhagyás után a 10 kontrollált tesztlevél kiküldése a rögzített plus-address címekre.
- [ ] Mobil, Gmail és Outlook megjelenés; linkek; Reply-To; ékezetek; pénz- és dátumformátum ellenőrzése.
- [ ] A Gmailes tesztfeladó kézbesítési eredményének és levélfejlécének ellenőrzése.
- [ ] A Kult2-migrációkor külön DKIM- és DMARC-ellenőrzés.
- [ ] Külön éles jóváhagyás után kis létszámú első küldés, majd Brevo napló és Sheet egyeztetés.

## Elfogadási feltételek

- A 10 valós kombináció mindegyike helyes, teljes levélelőnézetet ad.
- A Brevóban pontosan 6 aktív, verziózott Budai Táncklub tranzakciós sablon van.
- Egyetlen levél sem mehet ki emberi jóváhagyás nélkül az első éles szakaszban.
- A tesztfázisban a Brevóban ellenőrzött Gmail-feladóval mind a 10 kontrollált levél megérkezik a megfelelő plus-address címre.
- A későbbi Kult2-migráció csak sikeres domain-, DKIM- és DMARC-ellenőrzés után zárható le.
- A Brevo API-elfogadás, kézbesítés és hiba külön látható a Sheetben.
- Ismételt gombnyomás, Worker-hiba vagy webhook-ismétlés nem okoz dupla levelet.
- A levélre adott válasz a mindenkori konfigurált Reply-To postafiókba érkezik.

## Javasolt végrehajtási sorrend

1. Szöveg és adatkontraktus jóváhagyása.
2. Brevo API-kulcs, a már beállított Gmail-feladó és a meglévő brand/sablon ellenőrzése.
3. Sheet/Worker logika és a 6 verziózott sablon elkészítése.
4. Inaktív Brevo-sablonok API-szinkronja és renderelt előnézete.
5. Webhook, állapotgép és automata tesztek.
6. Kontrollált tesztküldés.
7. Tartalmi és kézbesítési jóváhagyás.
8. Kis létszámú éles indulás Gmail-feladóval, egyeztetés, majd normál használat.
9. Külön későbbi migráció a hitelesített Kult2 feladóra.

## Modellmunkamegosztás

- **Elsődleges implementáció:** a jelenlegi GPT-5-alapú Codex agent készíti a Worker-, Sheet-, teszt- és sablonszinkron kódot. Nem állítom, hogy ez a session GPT-5.6-on fut; csak a ténylegesen elérhető modellt nevezem meg.
- **Terra, ahol a workspace elérhetővé teszi:** adatmodell, állapotgép, idempotencia, biztonsági és integrációs ellenőrzés.
- **Luna, ahol a workspace elérhetővé teszi:** a hat magyar levélszöveg nyelvi ellenőrzése, felnőtt/szülő hangnem és renderelt e-mail vizuális QA.
- **Döntési kapuk:** a modellektől független automata tesztmátrix, a Sheetben látható végleges előnézet és Zsolt kézi jóváhagyása. Egy modell magabiztossága nem kézbesítési bizonylat.

## Mi változtathatja meg a tervet

1. **A meglévő Brevo-sablon nem tranzakciós vagy API-val nem őrzi meg a Drag & Drop szerkeszthetőséget.** Legkisebb teszt: sablonlista és egy dummy preview kiolvasása. Ha nem kompatibilis, egyszerű tranzakciós HTML-alapot készítünk a Brand Library logójával és színével.
2. **A későbbi `kult2.hu` DNS-migráció ütközik a jelenlegi levelezéssel vagy DMARC-szabállyal.** Legkisebb teszt: a meglévő DNS-rekordok kiolvasása. Ez nem blokkolja a Gmailes tesztfázist.
3. **A felnőtt/szülő besoroláshoz a forrásadat nem elég megbízható.** Legkisebb teszt: 20 anonim vagy maszkolt valós sor lefuttatása a szabályon. Ha sok a bizonytalan eset, explicit „saját nevében jelentkezik” mezőt kell tenni az űrlapra.

## Hivatalos Brevo-hivatkozások

- [Tranzakciós e-mail küldése `templateId` és `params` mezőkkel](https://developers.brevo.com/reference/send-transac-email)
- [Tranzakciós sablon létrehozása API-val](https://developers.brevo.com/reference/create-smtp-template)
- [Renderelt sablonelőnézet generálása](https://developers.brevo.com/reference/post-preview-smtp-email-templates)
- [Feladó létrehozása és kezelése](https://developers.brevo.com/docs/sender-creation-and-management)
- [Domainhitelesítés API-val](https://developers.brevo.com/docs/domain-authentication-and-verification)
- [Brevo code, DKIM és DMARC beállítása](https://help.brevo.com/hc/en-us/articles/12163873383186-Authenticate-your-domain-with-Brevo-Brevo-code-DKIM-DMARC)
- [Tranzakciós webhook események](https://developers.brevo.com/docs/transactional-webhooks)
- [Brevo Brand Library: logó, színek és automatikus öröklés az új e-mail-tervekben](https://help.brevo.com/hc/en-us/articles/7868807168274-Save-your-brand-s-assets-in-the-brand-library)
