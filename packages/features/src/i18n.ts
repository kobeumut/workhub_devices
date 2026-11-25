import { OcsError, taskDateFields } from '@workhub-devices/core';

/** Turkish UI strings (single locale for now; keys kept stable for future locales). */
export const t = {
  appName: 'Workhub',
  /** Module page headings, verbatim from the web app's Turkish catalogue (l10n/tr.json). */
  page: {
    projects: 'Projeler',
    projectsSub: 'Ekip projelerinizi, görevlerinizi ve zaman çizelgelerinizi yönetin.',
    workload: 'İş yükü',
    workloadSub: 'Okuyabildiğiniz tüm projeler',
    workflows: 'İş akışları',
    workflowsSub: 'Biten işi bir sonraki göreve dönüştüren şablonlar: otomatik olarak ya da kişiler arasında devirle.',
    dashboards: 'Gösterge panelleri',
    time: 'Zaman çizelgem',
    timeSub: 'Çalışma sürelerinizi kaydedin, günlük toplamları kontrol edin ve haftayı onaya gönderin.',
    requestsEyebrowTime: 'Talepler',
    requests: 'Talepler',
    requestsEyebrow: 'EKİP İÇİ TALEPLER',
    goals: 'Hedefler',
    ai: 'AI asistanı',
    admin: 'Yönetim',
    newProject: '+ Yeni proje',
    searchProjects: 'Proje ara…',
    pendingApprovals: 'Onay bekleyenler',
    goToApprovals: 'Onaylara git',
    showAll: (n: number) => `Tümünü göster (${n})`,
    assignedTasks: 'Atanan görevler',
    assignedTasksSub: 'Tüm projelerde size atanan görevler',
    allProjects: 'Tüm projeler',
    sentToYou: 'Size gönderildi',
    timesheetPending: 'Onay bekliyor',
    noProjectMatch: 'Aramaya uyan proje yok.',
    newGoal: 'Yeni hedef',
    closeForm: 'Formu kapat',
  },
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
  start: 'Başlangıç',
  taskSchedule: 'Görev planı',
  taskTitle: 'Görev başlığı',
  taskEstimate: 'Tahmini süre',
  taskStartDate: 'Başlangıç (YYYY-AA-GG)',
  taskDueDate: 'Bitiş (YYYY-AA-GG)',
  taskStartTime: 'Başlangıç saati (SS:DD)',
  taskDueTime: 'Bitiş saati (SS:DD)',
  taskEstimateHint: 'Örn. 1,5 / 1:30 / 90 dk',
  taskDateInvalid: 'Tarihleri YYYY-AA-GG, saatleri SS:DD biçiminde girin.',
  taskDateRange: 'Başlangıç, bitişten sonra olamaz.',
  taskEstimateInvalid: 'Tahmini süreyi saat, dakika veya SS:DD biçiminde girin.',
  taskTitleEmpty: 'Başlık boş olamaz.',
  taskPointsInvalid: 'Hikaye puanını 0–1000 arası tam sayı olarak girin.',
  taskPlannedDue: 'Planlanan bitiş',
  taskArchived: 'Arşivlendi',
  archivedTasks: 'Arşivlenen görevler',
  noArchivedTasks: 'Arşivlenmiş görev yok.',
  archiveTask: 'Görevi arşivle',
  unarchiveTask: 'Arşivden çıkar',
  activity: 'Etkinlik',
  activityDueChanged: (before: string, after: string) => `bitiş tarihini değiştirdi: ${before} → ${after}`,
  searchActivity: 'Etkinlikte ara',
  searchActivityHint: 'Görev, kişi veya metin ara',
  filterWorkloadMembers: 'Ekip üyelerini filtrele',
  overloadedOnly: 'Yalnızca aşırı yüklü kişiler',
  noWorkloadMembers: 'Bu filtreyle eşleşen üye yok.',
  olderActivity: 'Daha eski',
  emptyActivity: 'Henüz etkinlik yok.',
  activityUnavailable: 'Sunucuda Activity uygulaması kapalı; Deck geçmişi gösterilemiyor.',
  systemActor: 'Sistem',
  runningTimers: 'Çalışan zamanlayıcılar',
  startTimer: 'Zamanlayıcı başlat',
  stopTimer: 'Zamanlayıcıyı durdur',
  timerStarted: 'Zamanlayıcı bu görev için başladı.',
  timerStopped: 'Zamanlayıcı durduruldu.',
  taskTimeEntries: 'Bu görevdeki zaman kayıtlarım',
  taskTimeTracked: 'Görünen toplam süre',
  myTimeTracked: 'Kaydettiğim süre',
  noTaskTimeEntries: 'Bu görevde henüz zaman kaydınız yok.',
  addTimeEntry: 'Zaman kaydı ekle',
  editTimeEntry: 'Zaman kaydını düzenle',
  timeEntryReadOnly: 'Bu kayıt kilitli veya değiştirilemiyor.',
  timeOverlapSaved: 'Kaydedildi; ancak başka bir kayıtla çakışıyor.',
  timeEntryKindRange: 'Saat aralığı',
  timeEntryKindDuration: 'Süre',
  timeEntryDate: 'Tarih (YYYY-AA-GG)',
  timeEntryStart: 'Başlangıç (SS:DD)',
  timeEntryEnd: 'Bitiş (SS:DD)',
  timeEntryHours: 'Süre (saat)',
  timeEntryHoursHint: 'Örn. 1,5 veya 1:30',
  timeEntryDescription: 'Açıklama',
  timeEntryBillable: 'Faturalanabilir',
  timeEntryZone: 'Saat dilimi',
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
  projectList: 'Projeler',
  myAssignedTasks: 'Bana atanan görevler',
  assignmentStatus: { open: 'Açık', done: 'Tamamlanan', all: 'Tümü' },
  assignmentsTruncated: 'Görev listesinin yalnızca ilk bölümü gösteriliyor.',
  noAssignedTasks: 'Bu filtreye uyan atanmış göreviniz yok.',
  personalProject: 'Kişisel proje',
  reviewerProject: 'İnceleme erişimi',
  projectOpenCount: (count: number) => `${count} açık`,
  projectDoneCount: (count: number) => `${count} tamamlandı`,
  projectOverdueCount: (count: number) => `${count} gecikmiş`,
  projectAttentionCount: (count: number) => `${count} gecikmiş görev`,
  approvalsCount: (count: number) => `${count} kayıt onayınızı bekliyor`,
  waitingApprovals: 'Onay bekleyenler',
  approvalsPartial: 'Bazı onay kayıtları yüklenemedi.',
  timesheetApprovalPeriod: (from: string, to: string) => `Zaman çizelgesi · ${from}–${to}`,
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
  moveColumnEarlier: 'Öne taşı',
  moveColumnLater: 'Arkaya taşı',
  members: 'Üyeler',
  newMemberRights: 'Yeni üyenin yetkileri',
  permEdit: 'Düzenleyebilir',
  permShare: 'Üye ekleyebilir',
  permManage: 'Yönetebilir',
  addMember: 'Üye ekle: kişi veya grup ara',
  memberAdded: 'projeye eklendi.',
  projectOwner: 'Proje sahibi',
  removeMember: 'Üyeyi çıkar',
  confirmRemoveMember: (name: string) => `${name} projeden çıkarılsın mı? Bu projedeki görev atamaları da kaldırılabilir.`,
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

export const requestText = {
  inbox: 'Talep kutusu', approvals: 'Onaylar', mine: 'Gönderdiklerim', received: 'Bana gelenler', team: 'Ekibim', everyone: 'Herkes',
  report: 'Rapor', all: 'Tümü', noMine: 'Gönderdiğiniz talep yok.', noReceived: 'Size gelen talep yok.', noTeam: 'Gösterilecek ekip talebi yok.',
  noInbox: 'Talep kutusu boş.', noApprovals: 'İşleminizi bekleyen onay yok.', more: 'Daha fazla yükle',
  inboxMore: (shown: number, total: number) => `${total} kaydın ${shown} tanesi gösteriliyor. Diğer talepler için listeleri kullanın.`,
  awaiting: 'İşleminizi bekliyor', timesheetApprovals: 'Zaman çizelgesi onayları',
  newRequest: 'Yeni talep', title: 'Başlık', description: 'Açıklama', converted: 'Görev oluşturuldu.',
  details: 'Ayrıntı', openTask: 'Bağlı görevi aç', changeRecipient: 'Alıcı seç', recipientSearch: 'Alıcı ara',
  recipient: (name: string) => `Alıcı: ${name}`, noRecipient: 'Talep göndermek için bir alıcı seçin.',
  respondent: { title: 'Yanıtla', approve: 'Kabul et', reject: 'Reddet' },
  manager: { title: 'Yönetici kararı', approve: 'Yönetici olarak onayla', reject: 'Onaylama' },
  rejectReason: 'Reddetmek için gerekçe yazın.', reason: 'Gerekçe', rejectPlaceholder: 'Gerekçe (reddetmede zorunlu)',
  accepted: 'Talep kabul edildi.', rejected: 'Talep reddedildi.', managerApproved: 'Yönetici onayı verildi.', managerRejected: 'Talep yönetici tarafından onaylanmadı.',
  withdraw: 'Talebi geri çek', cancel: 'Talebi iptal et', optionalReason: 'Gerekçe (isteğe bağlı)',
  cancelled: 'Talep iptal edildi.', withdrawn: 'Talep geri çekildi.', cancelReason: (reason: string) => `İptal gerekçesi: ${reason}`,
  remind: 'Alıcıya Talk hatırlatması gönder', remindManagers: 'Yöneticilere Talk hatırlatması gönder',
  reminded: 'Alıcıya Talk hatırlatması gönderildi.', managersReminded: 'Yöneticilere Talk hatırlatması gönderildi.',
  remindAfter: (action: string, date: string) => `${action} · ${date} sonrasında`, talkUnavailable: 'Hatırlatmalar için Talk kullanılamıyor.',
  preApproved: 'Talep yönetici tarafından onaylandı; alıcının yanıtı bekleniyor.',
  pending: 'Alıcının onayı bekleniyor', recipientRejected: 'Alıcı reddetti', resolved: 'Görevsiz çözüldü',
  managerMissing: 'Nextcloud’da yönetici ataması bekleniyor', managerPending: 'Yöneticinin işlemi bekleniyor',
  approvedOpen: 'Yönetici onayladı · göreve dönüştürülmeyi bekliyor', cancelledByManager: 'İptal edildi · yönetici onaylamadı',
  taskClosed: 'Görev tamamlandı', taskMissing: 'Bağlı görev silinmiş veya erişilemiyor', taskOpen: 'Göreve dönüştü · sürüyor',
  approval: 'Onay durumu', status: 'Durum', person: 'Kişi', searchReportPeople: 'Rapordaki kişileri ara', morePeople: 'Daha fazla kişi göster',
  requests: 'Talepler', timesheets: 'Zaman çizelgeleri', timesheetPeriod: (from: string, to: string, duration: string) => `Zaman çizelgesi ${from}–${to}${duration ? ` · ${duration}` : ''}`,
  unsupportedFilters: 'Bu sunucu seçilen onay veya kişi filtresini uygulamadı.',
  approvalStatus: { any: 'Tümü', waiting: 'Bekliyor', approved: 'Onaylandı', rejected: 'Reddedildi', none: 'Onay yok' },
  state: {
    pending: 'Onay bekliyor', open: 'Açık', rejected: 'Reddedildi', converted: 'Göreve dönüştü', resolved: 'Çözüldü',
    cancelled: 'İptal edildi', approved: 'Onaylandı', changes_requested: 'Değişiklik istendi', withdrawn: 'Geri çekildi',
    superseded: 'Yeniden açıldı', manager_waiting: 'Yönetici onayı bekleniyor', manager_approved: 'Yönetici onayladı', manager_rejected: 'Yönetici onaylamadı',
  } as Record<string, string>,
  event: {
    'request.created': 'Talep açıldı', 'request.approved': 'Alıcı onayladı', 'request.rejected': 'Alıcı reddetti',
    'request.converted': 'Göreve dönüştürüldü', 'request.resolved': 'Görevsiz çözüldü',
    'request.task_closed': 'Görev tamamlandı olarak görüldü', 'request.task_reopened': 'Görev yeniden açık görüldü',
    'request.task_missing': 'Bağlı görev erişilemez', 'request.manager_approved': 'Yönetici onayladı', 'request.manager_rejected': 'Yönetici onaylamadı',
    'request.cancelled': 'Talep iptal edildi', 'request.withdrawn': 'Talep geri çekildi', 'request.reminded': 'Alıcıya hatırlatma gönderildi',
    'request.managers_reminded': 'Yöneticilere hatırlatma gönderildi', 'request.overdue': 'Talep yanıtsız kaldı',
  } as Record<string, string>,
};

/** Stable error codes with a specific explanation (files, quota, capability gates). */
const CODE_TEXT: Record<string, string> = {
  REMINDER_TOO_SOON: 'Alıcıya kısa süre önce hatırlatma gönderdiniz. Daha sonra tekrar deneyin.',
  MANAGER_REMINDER_TOO_SOON: 'Yöneticilere ilk hatırlatma 48 saat sonra, sonraki hatırlatmalar günde bir kez gönderilebilir.',
  NO_MANAGER: 'Alıcının etkin bir yöneticisi yok.',
  TALK_UNAVAILABLE: 'Siz veya alıcı Talk kullanamıyor.',
  TALK_UNAVAILABLE_MANAGERS: 'Alıcının yöneticileri Talk kullanamıyor.',
  TALK_FAILED: 'Talk mesajı gönderilemedi. Daha sonra tekrar deneyin.',
  QUOTA_EXCEEDED: 'Depolama kotanız dolu; dosya yüklenemedi. Yer açıp tekrar deneyin.',
  FILE_TOO_LARGE: 'Dosya sunucunun izin verdiği boyuttan büyük.',
  FILE_LOCKED: 'Dosya şu anda kilitli; biraz sonra tekrar deneyin.',
  FILE_GONE: 'Seçilen dosyaya artık ulaşılamıyor; yeniden seçin.',
  FILE_CHANGED: 'Dosya yükleme sırasında değişti; yeniden seçin.',
  FILES_UNSUPPORTED: 'Bu cihazda dosya işlemleri henüz desteklenmiyor.',
  TALK_FEATURE_MISSING: 'Sunucu bu Talk özelliğini desteklemiyor veya sizin için kapalı.',
  TALK_CHAT_FORBIDDEN: 'Bu sohbette yazma veya dosya paylaşma izniniz yok.',
  DOWNLOAD_HIDDEN: 'Paylaşan kişi bu dosyanın indirilmesini kapatmış.',
  OPEN_NOT_ALLOWED: 'Bu dosya türü güvenlik nedeniyle doğrudan açılamaz; indirip kaydedin.',
  INVALID_VOICE_MESSAGE: 'Sesli not WAV veya MP3 olmalı ve 25 MB’ı aşmamalı.',
  NOT_A_FILE: 'Bu mesajda indirilebilir bir dosya yok.',
  NAME_EXHAUSTED: 'Talk klasöründe bu adla çok fazla dosya var; dosyayı yeniden adlandırın.',
  MIC_DENIED: 'Mikrofon izni verilmedi veya mikrofon bulunamadı.',
  PLAYBACK_FAILED: 'Ses bu cihazda oynatılamadı; indirip açmayı deneyin.',
  BRIDGE_DEGRADED: 'Deck bağlantısı bu işlemi şu anda desteklemiyor. Diğer Workhub özelliklerini kullanmaya devam edebilirsiniz.',
  BRIDGE_UNAVAILABLE: 'Workhub’ın Deck bağlantısı şu anda kullanılamıyor.',
  INVALID_STACK_ORDER: 'Sütun sırası değişmiş. Panoyu yenileyip tekrar deneyin.',
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

export function formatTaskDate(iso: string, kind: 'start' | 'due', includeYear = false): string {
  const { date, time } = taskDateFields(iso, kind);
  if (!date) return '';
  const day = new Date(`${date}T12:00:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', ...(includeYear ? { year: 'numeric' } : {}) });
  return time ? `${day} · ${time}` : day;
}

export function formatDuration(sec: number): string {
  return `${Math.floor(sec / 3600)} sa ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')} dk`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}
