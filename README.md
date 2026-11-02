# Workhub Devices

Talk merkezli mesajlaşma ve mevcut Nextcloud Workhub özellikleri için iOS, Android, Windows, macOS ve Linux istemcisi.

**Durum: araştırma ve uygulama planı. Henüz çalıştırılabilir uygulama yok.** GENE-47 kapsamında hazırlanmış, uygulama **GENE-48** göreviyle Opus2 - Full Stack Developer'a devredilmiştir.

- [PLAN.md](PLAN.md): mimari, ayrıntılı işler, bağımlılıklar ve kabul/test ölçütleri.
- [RESEARCH.md](RESEARCH.md): incelenen kaynakların SHA'ları, API sözleşmeleri ve kritik bildirim bulguları.

Öneri: mobilde bare React Native; üç masaüstünde React Native Web + Electron; ortak TypeScript özellik/veri katmanı. Bu, Linux'ta native widget garantisi değildir.

Workhub deposunda değişiklik öngörülmez. Ancak markalı uygulamanın arka plan bildirimleri için kendi APNs/FCM yetkileri, uygun push altyapısı ve Talk + Workhub birlikte teslimatının gerçek sunucuda doğrulanması gerekir. Mevcut Talk uygulamasını kopyalamak veya yalnızca push URL'sini değiştirmek yeterli değildir.
