# Workhub Devices

## Önce oku

- `PLAN.md`: kapsam, fazlar ve kabul ölçütleri; işe başlamadan güncelle, tamamlandıkça checkbox işaretle.
- `RESEARCH.md`: pinned kaynaklar ve kritik sürüm/push routing sınırları. Geliştirme snapshot'ı hedef sunucunun sürümü değildir.

## Sınırlar

- Bu depo başlangıçta yalnız plan içerir; build/test komutu henüz yok. Gelecek komutları gerçekten oluşturup çalıştırdıktan sonra README'ye yaz.
- Talk ana ekran; beş hedef iOS, Android, Windows, macOS, Linux. Masaüstü önerisi RN Web + Electron'dur; native widget garantisi değildir.
- Workhub reposunu varsayılan olarak değiştirme. Gerekirse kanıtla ve önceden onay al.
- Native Talk push aboneliği Workhub push kapsamaz. Birleşik push fizibilitesini gerçek sunucu/cihazla kanıtlamadan bildirim kabulünü tamamlanmış sayma.
- Secret/token/mesaj gövdesini Git'e, issue'ya veya log'a yazma. Desktop renderer raw credential alamaz.
- En küçük çalışan dikey dilimi kur; yeni backend, genel sync engine, gereksiz bağımlılık/abstraction ekleme. Her non-trivial değişiklik runnable regression check bırakmalı.
- Testte bağlı fiziksel cihazı öncele; yoksa mevcut sim/emulator. Test için yeni sim/emulator yaratma. Gerçek native push kabulü cihaz testidir.
- PR'da çalıştırılan test/build, doğrulanmayan platform ve kalan blocker'ları açıkça belirt. Mock/simulator sonucunu production push veya beş OS kanıtı olarak sunma.
