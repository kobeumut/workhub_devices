# ADR 0001 — Push taşıması: Nextcloud Web Push → Firebase (FCM) relay

Durum: **Kabul edildi** (2026-11-02, ürün sahibi onayı: Web Push açılabilir, marka `com.next.workhub`, relay yerine mümkünse Firebase)

## Bağlam

- Talk mesajı ve normal Workhub ataması **aynı hesapta, aynı cihazda** arka planda gelmeli; resmî Talk uygulaması da kuruluyken kayıp olmamalı.
- Notifications 8.0.1 native push v2, Talk ailesini yalnız Talk türü kayıtlara, diğer uygulamaları (Workhub) yalnız diğer kayıtlara gönderir. Tek native kayıt ikisini güvenle kapsamaz. Ayrıca Nextcloud'un resmî push proxy'si markalı bir uygulamaya teslim etmez.
- Notifications 8.0.1 Web Push v2 içerir: bir abonelik `appTypes=talk,workhub` ile iki aileyi birlikte alır ve diğer istemcilerin kayıtlarından bağımsızdır.
- Nextcloud yalnız Web Push protokolüyle (RFC 8030, VAPID imzalı, RFC 8291 şifreli) gönderir. FCM ve APNs bu protokolü native uygulamalar için **kabul etmez**. Bu yüzden arada protokol çeviren çok küçük bir uç nokta şarttır. "Doğrudan Firebase" mümkün değil; en yakın seçenek bu ucu **Firebase'in içinde** (Cloud Functions) çalıştırmaktır.

## Karar

```
Nextcloud (Web Push, VAPID + aes128gcm)
   │  POST https://<relay>/wp/<FCM token>?k=<sunucu VAPID anahtarı>
   ▼
Firebase Cloud Function `webpush`  (services/push-relay, durumsuz)
   │  VAPID imzasını URL'de sabitlenen anahtarla doğrular, şifreli gövdeyi açmadan iletir
   ▼
FCM ──► Android: FirebaseMessagingService (native decrypt, bildirim, RemoteInput yanıt)
   └──► APNs (Firebase'e yüklenen APNs anahtarıyla) ──► iOS Notification Service Extension (native decrypt)
```

- Relay **hiçbir şey saklamaz**: veritabanı yok, anahtar yok, içerik yok. Nextcloud kimlik bilgisi görmez ve şifre çözemez.
- Güvenlik: endpoint URL'sinde sunucunun VAPID açık anahtarı sabitlenir. Yalnız o Nextcloud'un imzaladığı istekler cihaza ulaşır; URL sızsa bile başkası push atamaz.
- Boyut: Nextcloud içeriği 2820 bayta pad'leyip şifreler (~2.9 KB). base64url hali ~3.9 KB ile FCM/APNs 4 KB sınırına sığar ve şifreli içerik doğrudan iletilir. Daha büyük gövdelerde yalnız `topic=nid<id>` gider; uygulama `GET notifications/{id}` ile kendi kimliğiyle çeker (404 = silindi).
- Silme olayları (`delete`, `delete-multiple`, `delete-all`) aynı kanaldan gelir ve OS bildirimini kaldırır.
- Öncelik: Talk `high`. Workhub ve silmeler `normal`; ikisi de kullanıcıya görünür bildirim ürettiği için Android `high` ve APNs `10` ile gönderilir. `low`/`very-low` düşük öncelikle gider.
- FCM hata eşlemesi: kayıtsız/geçersiz token → 410 (Nextcloud aboneliği siler). Kota → 429 + Retry-After. Diğer hatalar → 503; aboneliği sildirmez.

## Sonuçlar

- Workhub, Talk veya Notifications kodunda değişiklik **gerekmez**. Yalnız admin ayarı: `occ config:app:set notifications webpush_enabled --value=true --type=boolean`.
- Firebase projesi **Blaze** (kullandıkça öde) planı ister; Cloud Functions ücretsiz planda çalışmaz. Bildirim hacmi için maliyet düşüktür; ücretsiz kotalar geniştir.
- iOS: NSE her uyarıyı görünür hale getirmeden önce değiştirebilir ama **gizleyemez**. Silme/kontrol push'larının görünmeden işlenmesi için Apple'dan `com.apple.developer.usernotifications.filtering` yetkisi istenmeli. Yetki gelene kadar silme push'u kısa bir genel uyarı olarak görünebilir; bu bilinen sınırlamadır.
- iOS'ta kullanıcı uygulamayı zorla kapatsa da alert push gelir. Android'de "Durmaya zorla" sonrası FCM teslim etmez (OS kuralı); uygulama açılınca inbox senkronu yapılır.
- Kanıt: `services/push-relay/test/e2e.live.ts`. Gerçek Nextcloud → relay → (taklit FCM) → cihaz tarafı decrypt; Talk + normal atama + unassign delete tek abonelikte geçti. Gerçek FCM/APNs ve fiziksel cihaz testi Firebase bilgileri eklenince yapılacak.

## Reddedilen seçenekler

- **Native push v2 + kendi proxy'miz:** Talk/diğer ayrımı nedeniyle tek kayıt yetmez; iki kayıt aynı token hash'iyle tekilleşir; UA taklidi kabul edilemez.
- **UnifiedPush:** Android'de ek dağıtıcı uygulama ister; iOS çözümü yok.
- **Arka planda periyodik polling:** gerçek zamanlı değil, pil ve OS sınırları; push yerine sunulamaz.
