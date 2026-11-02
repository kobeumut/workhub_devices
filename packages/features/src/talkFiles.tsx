import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import {
  canOpenSafely, formatBytes, newReferenceId, OcsError,
  type AccountId, type PickedFile, type TalkFile, type TransferProgress,
} from '@workhub-devices/core';
import { useServices, type AudioPlayback } from './services';
import { Button } from './ui';
import { colors, font, space } from './theme';
import { describeError } from './i18n';

let txSeq = 0;
const newTransferId = () => `tx-${Date.now().toString(36)}-${(txSeq++).toString(36)}`;
const percent = (p: TransferProgress | null) => (p && p.total > 0 ? Math.min(100, Math.floor((p.sent / p.total) * 100)) : 0);

/** Poll `backend.transfer(id)` while a transfer runs (works the same over IPC and direct). */
function useProgress(id: string | null) {
  const { backend } = useServices();
  const [p, setP] = useState<TransferProgress | null>(null);
  useEffect(() => {
    if (!id) return setP(null);
    let alive = true;
    const tick = () => backend.transfer(id).then((x) => alive && x && setP(x), () => undefined);
    const h = setInterval(tick, 300);
    void tick();
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [id, backend]);
  return p;
}

function ProgressBar({ label, p }: { label: string; p: TransferProgress | null }) {
  const pct = percent(p);
  const phase = p?.phase === 'preparing' ? 'hazırlanıyor' : p?.phase === 'sharing' ? 'paylaşılıyor' : `%${pct}`;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct, text: phase }}
      style={{ height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden', marginVertical: 2 }}
    >
      <View style={{ width: `${pct}%`, height: 6, backgroundColor: colors.primary }} />
    </View>
  );
}

// ---- Uploads ---------------------------------------------------------------------

export interface UploadItem {
  id: string;
  file: PickedFile;
  voice: boolean;
  caption?: string;
  replyTo?: number;
  referenceId: string;
  state: 'uploading' | 'failed' | 'cancelled';
  error?: unknown;
}

/**
 * Upload queue of one chat. Each item keeps its handle until the share succeeded (the Backend
 * releases it then), so a failed upload can be retried without re-picking; dismissing releases it.
 */
export function useUploads(accountId: AccountId, token: string) {
  const { backend, platform } = useServices();
  const [items, setItems] = useState<UploadItem[]>([]);
  const patch = (id: string, p: Partial<UploadItem>) => setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const run = useCallback(
    async (it: UploadItem) => {
      try {
        await backend.shareFile(accountId, token, it.file.handle, {
          transferId: it.id,
          referenceId: it.referenceId,
          ...(it.caption ? { caption: it.caption } : {}),
          ...(it.replyTo ? { replyTo: it.replyTo } : {}),
          ...(it.voice ? { voice: true } : {}),
        });
        setItems((prev) => prev.filter((x) => x.id !== it.id));
      } catch (e) {
        const cancelled = e instanceof OcsError && e.kind === 'aborted';
        patch(it.id, { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : e });
      }
    },
    [accountId, token, backend],
  );
  const start = (file: PickedFile, o: { voice?: boolean; caption?: string; replyTo?: number } = {}) => {
    const it: UploadItem = { id: newTransferId(), file, voice: !!o.voice, referenceId: newReferenceId(), state: 'uploading', ...(o.caption ? { caption: o.caption } : {}), ...(o.replyTo ? { replyTo: o.replyTo } : {}) };
    setItems((prev) => [...prev, it]);
    void run(it);
  };
  const retry = (it: UploadItem) => {
    // Same referenceId: if the first share actually reached the server, Talk shows one message.
    const again = { ...it, id: newTransferId(), state: 'uploading' as const };
    setItems((prev) => prev.map((x) => (x.id === it.id ? again : x)));
    void run(again);
  };
  const cancel = (it: UploadItem) => void backend.cancel(it.id);
  const dismiss = (it: UploadItem) => {
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    void platform.files?.release(it.file.handle);
  };
  return { items, start, retry, cancel, dismiss };
}

function UploadRow({ it, onCancel, onRetry, onDismiss }: { it: UploadItem; onCancel: () => void; onRetry: () => void; onDismiss: () => void }) {
  const p = useProgress(it.state === 'uploading' ? it.id : null);
  const label = `${it.voice ? 'Sesli not' : it.file.name} yükleniyor`;
  return (
    <View style={{ paddingHorizontal: space(3), paddingVertical: space(1), borderTopWidth: 1, borderColor: colors.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.text }}>
          {it.voice ? '🎤' : '📎'} {it.file.name} <Text style={{ color: colors.muted, fontSize: font.small }}>{formatBytes(it.file.size)}</Text>
        </Text>
        {it.state === 'uploading' ? <Button kind="secondary" title="İptal" accessibilityLabel={`Yüklemeyi iptal et: ${it.file.name}`} onPress={onCancel} /> : null}
        {it.state !== 'uploading' ? <Button kind="secondary" title="Tekrar dene" accessibilityLabel={`Yeniden yükle: ${it.file.name}`} onPress={onRetry} /> : null}
        {it.state !== 'uploading' ? <Button kind="secondary" title="Kaldır" accessibilityLabel={`Listeden kaldır: ${it.file.name}`} onPress={onDismiss} /> : null}
      </View>
      {it.state === 'uploading' ? <ProgressBar label={label} p={p} /> : null}
      {it.state === 'uploading' && p ? (
        <Text style={{ color: colors.muted, fontSize: font.small }}>
          {p.phase === 'preparing' ? 'Hazırlanıyor…' : p.phase === 'sharing' ? 'Sohbete paylaşılıyor…' : `${formatBytes(p.sent)} / ${formatBytes(p.total)} (%${percent(p)})`}
        </Text>
      ) : null}
      {it.state === 'cancelled' ? <Text style={{ color: colors.muted, fontSize: font.small }}>Yükleme iptal edildi.</Text> : null}
      {it.state === 'failed' ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: font.small }}>{describeError(it.error)}</Text> : null}
    </View>
  );
}

export function UploadTray({ uploads }: { uploads: ReturnType<typeof useUploads> }) {
  if (!uploads.items.length) return null;
  return (
    <View accessibilityLabel="Dosya yüklemeleri">
      {uploads.items.map((it) => (
        <UploadRow key={it.id} it={it} onCancel={() => uploads.cancel(it)} onRetry={() => uploads.retry(it)} onDismiss={() => uploads.dismiss(it)} />
      ))}
    </View>
  );
}

// ---- Voice recording -------------------------------------------------------------

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Record → stop → upload as `voice-message`; cancel discards. */
export function VoiceBar({ onRecorded, onError, onClose }: { onRecorded: (f: PickedFile) => void; onError: (e: unknown) => void; onClose: () => void }) {
  const { platform } = useServices();
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !platform.voice) return;
    started.current = true;
    platform.voice.start().then(
      () => setSince(Date.now()),
      () => {
        onError(new OcsError('forbidden', undefined, undefined, undefined, 'MIC_DENIED'));
        onClose();
      },
    );
    return undefined;
  }, [platform, onError, onClose]);
  useEffect(() => {
    if (since === null) return;
    const h = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(h);
  }, [since]);
  // Leaving the chat while recording discards the recording.
  useEffect(() => () => void (started.current && platform.voice?.cancel()), [platform]);
  const stop = async () => {
    setBusy(true);
    try {
      const f = await platform.voice!.stop();
      started.current = false;
      if (f) onRecorded(f);
      else onError(new OcsError('client', undefined, 'Kayıt çok kısa.'));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), padding: space(2), borderTopWidth: 1, borderColor: colors.border }}>
      <Text accessibilityRole="timer" accessibilityLabel={since ? `Kaydediliyor, ${clock(now - since)}` : 'Mikrofon açılıyor'} style={{ flex: 1, color: colors.danger, fontWeight: '600' }}>
        {since ? `● Kaydediliyor ${clock(now - since)}` : 'Mikrofon açılıyor…'}
      </Text>
      <Button
        kind="secondary"
        title="Vazgeç"
        accessibilityLabel="Kaydı iptal et"
        onPress={() => {
          started.current = false;
          void platform.voice?.cancel();
          onClose();
        }}
      />
      <Button title="Gönder" accessibilityLabel="Sesli notu gönder" disabled={!since} busy={busy} onPress={() => void stop()} />
    </View>
  );
}

// ---- File messages ---------------------------------------------------------------

/**
 * A shared file in the timeline: name/size, download (save dialog / share sheet), open (safe types
 * only) and in-app playback for voice notes. Every action re-reads the message on the server.
 */
export function FileCard({ accountId, token, messageId, file }: { accountId: AccountId; token: string; messageId: number; file: TalkFile }) {
  const { backend, platform } = useServices();
  const [tx, setTx] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [playing, setPlaying] = useState<AudioPlayback | null>(null);
  const [loadingClip, setLoadingClip] = useState(false);
  const p = useProgress(tx);
  useEffect(() => () => playing?.stop(), [playing]);

  const download = async (mode: 'save' | 'open') => {
    const id = newTransferId();
    setError(undefined);
    setNotice('');
    setTx(id);
    try {
      const r = await backend.downloadFile(accountId, token, messageId, mode, id);
      setNotice(r === 'saved' ? 'Kaydedildi.' : r === 'opened' ? 'Açıldı.' : '');
    } catch (e) {
      if (!(e instanceof OcsError && e.kind === 'aborted')) setError(e);
    } finally {
      setTx(null);
    }
  };
  const play = async () => {
    if (playing) {
      playing.stop();
      setPlaying(null);
      return;
    }
    setError(undefined);
    setLoadingClip(true);
    try {
      const clip = await backend.voiceClip(accountId, token, messageId);
      const pb = await platform.playAudio!(clip).catch(() => {
        throw new OcsError('client', undefined, undefined, undefined, 'PLAYBACK_FAILED');
      });
      setPlaying(pb);
      void pb.ended.then(() => setPlaying((cur) => (cur === pb ? null : cur)));
    } catch (e) {
      setError(e);
    } finally {
      setLoadingClip(false);
    }
  };

  const canDownload = !file.hideDownload && !!platform.files;
  const audio = file.voice || file.mimetype.startsWith('audio/');
  return (
    <View accessibilityLabel={`${file.voice ? 'Sesli not' : 'Dosya'}: ${file.name}, ${formatBytes(file.size)}`} style={{ marginTop: 2, gap: space(1) }}>
      <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={2}>
        {file.voice ? '🎤 Sesli not' : `📎 ${file.name}`} <Text style={{ color: colors.muted, fontSize: font.small, fontWeight: '400' }}>{formatBytes(file.size)}</Text>
      </Text>
      {file.hideDownload ? <Text style={{ color: colors.muted, fontSize: font.small }}>Paylaşan kişi indirmeyi kapatmış.</Text> : null}
      {canDownload ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1) }}>
          {audio && platform.playAudio ? (
            <Button kind="secondary" title={playing ? '■ Durdur' : '▶ Dinle'} accessibilityLabel={playing ? 'Oynatmayı durdur' : `Dinle: ${file.name}`} busy={loadingClip} onPress={() => void play()} />
          ) : null}
          {tx ? (
            <Button kind="secondary" title="İptal" accessibilityLabel="İndirmeyi iptal et" onPress={() => void backend.cancel(tx)} />
          ) : (
            <>
              <Button kind="secondary" title={platform.kind === 'desktop' ? 'İndir' : 'Kaydet / paylaş'} accessibilityLabel={`İndir: ${file.name}`} onPress={() => void download('save')} />
              {canOpenSafely(file.name) ? <Button kind="secondary" title="Aç" accessibilityLabel={`Aç: ${file.name}`} onPress={() => void download('open')} /> : null}
            </>
          )}
        </View>
      ) : null}
      {tx ? <ProgressBar label={`${file.name} indiriliyor`} p={p} /> : null}
      {notice ? <Text accessibilityRole="alert" style={{ color: colors.ok, fontSize: font.small }}>{notice}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: font.small }}>{describeError(error)}</Text> : null}
    </View>
  );
}
