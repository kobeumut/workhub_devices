/**
 * Lucide icon set (ISC), one consistent 1.75px-stroke outline family on every platform.
 * Mobile renders `lucide-react-native` through `react-native-svg`; the desktop renderer aliases
 * `lucide-react-native` to `lucide-react` (DOM SVG, same component names and props — see
 * `apps/desktop/vite.config.ts`). Icons are decorative: the surrounding control carries the
 * accessible name, so every icon is hidden from screen readers.
 */
import {
  Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Calendar, ChartGantt, Check, ChevronDown, ChevronLeft, ChevronRight,
  Circle, CircleCheck, CircleUser, Clock, Ellipsis, FolderKanban, Funnel, Inbox, Kanban, LayoutDashboard, List, ListChecks, LogOut,
  MessageCircle, MessageSquare, Mic, MicOff, Phone, PhoneIncoming, PhoneOff, Plus, Search, Send, Server, Settings, ShieldCheck,
  Sparkles, SquareKanban, SwitchCamera, Target, Timer, User, UserPlus, Users, Video, VideoOff, Volume2, Workflow, X,
} from 'lucide-react-native';
import { View } from 'react-native';
import { colors } from './theme';

const ICONS = {
  activity: Activity,
  admin: ShieldCheck,
  ai: Sparkles,
  arrowDown: ArrowDown,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrowUp: ArrowUp,
  back: ChevronLeft,
  bell: Bell,
  calendar: Calendar,
  call: Phone,
  callEnd: PhoneOff,
  callIncoming: PhoneIncoming,
  chat: MessageCircle,
  check: Check,
  checkCircle: CircleCheck,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  circle: Circle,
  clock: Clock,
  close: X,
  comment: MessageSquare,
  dashboard: LayoutDashboard,
  filter: Funnel,
  gantt: ChartGantt,
  goals: Target,
  inbox: Inbox,
  kanban: Kanban,
  list: List,
  logout: LogOut,
  mic: Mic,
  micOff: MicOff,
  more: Ellipsis,
  plus: Plus,
  projects: FolderKanban,
  requests: Inbox,
  search: Search,
  send: Send,
  server: Server,
  settings: Settings,
  speaker: Volume2,
  subtasks: ListChecks,
  switchCamera: SwitchCamera,
  tasks: SquareKanban,
  timer: Timer,
  user: User,
  userPlus: UserPlus,
  users: Users,
  video: Video,
  videoOff: VideoOff,
  workflow: Workflow,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, color = colors.text, strokeWidth = 1.75 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const C = ICONS[name];
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden pointerEvents="none" style={{ width: size, height: size }}>
      <C size={size} color={color} strokeWidth={strokeWidth} />
    </View>
  );
}
