import { defineCatalog } from '../core';

/** Workhub module navigation (tabs, side navigation) and the server administration pointer. */
export default defineCatalog(
  {
    // Navigation.
    navLabel: 'Workhub navigation',
    sectionProjects: 'Projects',
    sectionWorkload: 'Workload',
    sectionWorkflows: 'Workflows',
    sectionDashboards: 'Dashboards',
    sectionAi: 'AI assistant',
    sectionGoals: 'Goals',
    sectionRequests: 'Requests',
    sectionTime: 'Time',
    sectionAdmin: 'Administration',
    projectNavLabel: (title: string, openCount: number) => `${title}, ${openCount} open ${openCount === 1 ? 'task' : 'tasks'}`,

    // Server administration (Nextcloud admins only).
    adminIntro: "Workhub is administered in your server's web interface (admin settings → Workhub): every change requires Nextcloud password confirmation, and this app never asks for or stores your admin password.",
    adminSettingsTitle: 'Workhub admin settings ↗',
    adminSettingsSubtitle: 'Modules and group restrictions, AI provider and usage, time policy, workload capacity, Deck import',
  },
  {
    // Navigation.
    navLabel: 'Workhub gezinmesi',
    sectionProjects: 'Projeler',
    sectionWorkload: 'İş yükü',
    sectionWorkflows: 'İş akışları',
    sectionDashboards: 'Dashboard',
    sectionAi: 'AI asistanı',
    sectionGoals: 'Hedefler',
    sectionRequests: 'Talepler',
    sectionTime: 'Zaman',
    sectionAdmin: 'Yönetim',
    projectNavLabel: (title: string, openCount: number) => `${title}, ${openCount} açık görev`,

    // Server administration (Nextcloud admins only).
    adminIntro: 'Workhub yönetimi sunucunuzun web arayüzünde (Yönetim ayarları → Workhub) yapılır: her değişiklik Nextcloud parola onayı ister ve bu uygulama yönetici parolanızı almaz, saklamaz.',
    adminSettingsTitle: 'Workhub yönetim ayarları ↗',
    adminSettingsSubtitle: 'Modüller ve grup kısıtları, AI sağlayıcısı ve kullanım, zaman politikası, iş yükü kapasitesi, Deck içe aktarma',
  },
);
