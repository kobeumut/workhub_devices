import { OcsError } from '@workhub-devices/core';

/** Turkish UI strings (single locale for now; keys kept stable for future locales). */
export const t = {
  appName: 'Workhub',
  chats: 'Sohbetler',
  tasks: 'İşler',
  inbox: 'Bildirimler',
  account: 'Hesap',
  loading: 'Yükleniyor…',
  retry: 'Tekrar dene',
  send: 'Gönder',
  cancel: 'İptal',
  save: 'Kaydet',
  back: 'Geri',
  serverUrl: 'Sunucu adresi',
  serverHint: 'ör. cloud.sirketiniz.com',
  connect: 'Bağlan',
  loginWaiting: 'Tarayıcıda girişi onaylayın. Bu ekran onaydan sonra kendiliğinden devam eder.',
  openBrowserAgain: 'Tarayıcıyı tekrar aç',
  addAccount: 'Hesap ekle',
  logout: 'Çıkış yap',
  logoutDone: 'Çıkış yapıldı.',
  noRooms: 'Henüz sohbet yok.',
  noMessages: 'Henüz mesaj yok.',
  messagePlaceholder: 'Mesaj yazın',
  sending: 'gönderiliyor…',
  failed: 'gönderilemedi — tekrar denemek için dokunun',
  unknownState: 'durum belirsiz — sunucuyla eşleştiriliyor',
  noProjects: 'Erişebildiğiniz proje yok.',
  noTasks: 'Bu listede görev yok.',
  noNotifications: 'Bildirim yok.',
  markDone: 'Tamamlandı olarak işaretle',
  markUndone: 'Yeniden aç',
  move: 'Taşı',
  comments: 'Yorumlar',
  addComment: 'Yorum ekle',
  assignees: 'Atananlar',
  due: 'Bitiş',
  priority: 'Öncelik',
  newTask: 'Yeni görev',
  editTask: 'Görevi düzenle',
  edit: 'Düzenle',
  taskGone: 'Bu görev silinmiş.',
  taskForbidden: 'Bu göreve artık erişiminiz yok.',
  featureOff: 'Projeler modülü bu hesap için kapalı.',
  incompatible: 'Sunucu uyumsuz',
  dismiss: 'Kaldır',
  workhubMissing: 'Bu sunucuda Workhub kurulu değil.',
  previews: 'Kilit ekranında mesaj önizlemesi',
  servers: 'Bağlı hesaplar',
  version: 'Sürüm',
  newProject: 'Yeni proje',
  create: 'Oluştur',
  manage: 'Yönet',
  close: 'Kapat',
  projectSettings: 'Proje ayarları',
  projectName: 'Proje adı',
  rename: 'Yeniden adlandır',
  renameProject: 'Projeyi yeniden adlandır',
  columns: 'Sütunlar',
  columnName: 'Sütun adı',
  newColumn: 'Yeni sütun',
  addColumn: 'Sütun ekle',
  members: 'Üyeler',
  newMemberRights: 'Yeni üyenin yetkileri',
  permEdit: 'Düzenleyebilir',
  permShare: 'Üye ekleyebilir',
  permManage: 'Yönetebilir',
  addMember: 'Üye ekle: kişi veya grup ara',
  memberAdded: 'projeye eklendi.',
  memberRemoveGap: 'Üye çıkarma ve yetki değiştirme için Workhub API\'si yok.',
  searchPeople: 'Kişi veya grup ara',
  noMatches: 'Eşleşen kişi veya grup yok.',
  pick: 'Seç',
  shares: 'Paylaşımlar',
  owner: 'Sahip',
  noShares: 'Henüz kimseyle paylaşılmadı.',
  addShare: 'Paylaş: kişi veya grup ara',
  removeShare: 'Kaldır',
  sharesSaved: 'Paylaşımlar kaydedildi.',
};

/** Stable error codes with a specific explanation (files, quota, capability gates). */
const CODE_TEXT: Record<string, string> = {
  QUOTA_EXCEEDED: 'Depolama kotanız dolu; dosya yüklenemedi. Yer açıp tekrar deneyin.',
  FILE_TOO_LARGE: 'Dosya sunucunun izin verdiği boyuttan büyük.',
  FILE_LOCKED: 'Dosya şu anda kilitli; biraz sonra tekrar deneyin.',
  FILE_GONE: 'Seçilen dosyaya artık ulaşılamıyor; yeniden seçin.',
  FILE_CHANGED: 'Dosya yükleme sırasında değişti; yeniden seçin.',
  FILES_UNSUPPORTED: 'Bu cihazda dosya işlemleri henüz desteklenmiyor.',
  CALL_SERVER_DISABLED: 'Aramalar bu sunucuda kapalı.',
  CALL_FEATURE_MISSING: 'Sunucudaki Talk sürümü aramaları desteklemiyor.',
  CALL_ROOM_TYPE: 'Bu sohbette arama yapılamaz.',
  CALL_READ_ONLY: 'Sohbet salt okunur; arama yapılamaz.',
  CALL_LOBBY: 'Sohbet lobide; moderatör sizi içeri alana kadar aramaya katılamazsınız.',
  CALL_NO_PERMISSION: 'Bu sohbette arama başlatma veya katılma izniniz yok.',
  CALL_NOT_FOUND: 'Görüşme sona erdi.',
  SIGNALING_UNSUPPORTED: 'Sunucunun sinyal sunucusuna bu cihazdan bağlanılamıyor.',
  SIGNALING_UNAVAILABLE: 'Sunucunun sinyal sunucusu yapılandırılmamış.',
  TALK_FEATURE_MISSING: 'Sunucu bu Talk özelliğini desteklemiyor veya sizin için kapalı.',
  TALK_CHAT_FORBIDDEN: 'Bu sohbette yazma veya dosya paylaşma izniniz yok.',
  DOWNLOAD_HIDDEN: 'Paylaşan kişi bu dosyanın indirilmesini kapatmış.',
  OPEN_NOT_ALLOWED: 'Bu dosya türü güvenlik nedeniyle doğrudan açılamaz; indirip kaydedin.',
  INVALID_VOICE_MESSAGE: 'Sesli not WAV veya MP3 olmalı ve 25 MB’ı aşmamalı.',
  NOT_A_FILE: 'Bu mesajda indirilebilir bir dosya yok.',
  NAME_EXHAUSTED: 'Talk klasöründe bu adla çok fazla dosya var; dosyayı yeniden adlandırın.',
  MIC_DENIED: 'Mikrofon izni verilmedi veya mikrofon bulunamadı.',
  PLAYBACK_FAILED: 'Ses bu cihazda oynatılamadı; indirip açmayı deneyin.',
};

export function describeError(e: unknown): string {
  if (e instanceof OcsError) {
    if (e.errorCode && CODE_TEXT[e.errorCode]) return CODE_TEXT[e.errorCode]!;
    if (e.status === 507) return CODE_TEXT.QUOTA_EXCEEDED!;
    switch (e.kind) {
      case 'aborted':
        return 'İptal edildi.';
      case 'unauthorized':
        return 'Oturum geçersiz veya uygulama parolası iptal edilmiş. Lütfen tekrar giriş yapın.';
      case 'forbidden':
        return e.errorCode?.endsWith('_DISABLED') ? 'Bu modül sizin için kapalı.' : 'Bu işlem için yetkiniz yok.';
      case 'not_found':
        return 'Kayıt bulunamadı; silinmiş olabilir.';
      case 'conflict':
        return 'Kayıt bu arada değişti. Yenileyip tekrar deneyin.';
      case 'rate_limited':
        return `Çok fazla istek. ${Math.ceil((e.retryAfterMs ?? 60000) / 1000)} sn sonra tekrar deneyin.`;
      case 'network':
        return 'Sunucuya ulaşılamıyor. Bağlantınızı kontrol edin.';
      case 'timeout':
        return 'Sunucu zamanında yanıt vermedi.';
      case 'redirect':
        return 'Sunucu beklenmeyen bir yönlendirme yaptı; güvenlik nedeniyle durduruldu.';
      case 'server':
        return 'Sunucu hatası. Biraz sonra tekrar deneyin.';
      default:
        if (e.kind.startsWith('url:')) return urlError(e.kind.slice(4));
        if (e.kind.startsWith('login:')) return loginError(e.kind.slice(6));
        return e.ocsMessage || 'İşlem başarısız oldu.';
    }
  }
  const err = e as { name?: string; code?: string };
  if (err?.name === 'ServerUrlError') return urlError(err.code ?? '');
  if (err?.name === 'LoginFlowError') return loginError(err.code ?? '');
  return 'Beklenmeyen bir hata oluştu.';
}

function urlError(code: string) {
  return (
    {
      empty: 'Sunucu adresini girin.',
      insecure: 'Yalnız HTTPS sunucular desteklenir.',
      userinfo: 'Adreste kullanıcı adı/parola olmamalı.',
      query: 'Adres sorgu parametresi içermemeli.',
      fragment: 'Adres # içermemeli.',
    } as Record<string, string>
  )[code] ?? 'Geçersiz sunucu adresi.';
}

function loginError(code: string) {
  return (
    {
      cancelled: 'Giriş iptal edildi.',
      expired: 'Giriş süresi doldu, tekrar deneyin.',
      untrusted_endpoint: 'Sunucu giriş için farklı bir adrese yönlendirdi; güvenlik nedeniyle durduruldu.',
      start_failed: 'Bu adreste Nextcloud girişi başlatılamadı.',
      network: 'Sunucuya ulaşılamadı.',
    } as Record<string, string>
  )[code] ?? 'Giriş başarısız oldu.';
}

export function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}
