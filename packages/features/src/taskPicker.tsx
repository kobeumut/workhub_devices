import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { AccountId, BoardPayload, ProjectSummary, Task } from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Chip } from './taskEdit';
import { Loading, styles as ui } from './ui';
import { colors, font, space } from './theme';
import { describeError } from './i18n';

export interface PickedTask {
  id: number;
  boardId: number;
  title: string;
}

/** Project chips (readable projects only; the server lists what the user may read). */
export function ProjectChips({ accountId, value, onChange, filter }: {
  accountId: AccountId;
  value: number | null;
  onChange: (p: Pick<ProjectSummary, 'id' | 'title'>) => void;
  filter?: (p: ProjectSummary) => boolean;
}) {
  const { backend } = useServices();
  const projects = useAsync(() => backend.projects(accountId), [accountId]);
  if (projects.loading && !projects.data) return <Loading />;
  if (projects.error) return <Text accessibilityRole="alert" style={{ color: colors.danger }}>{describeError(projects.error)}</Text>;
  const list = (projects.data ?? []).filter((p) => !p.archived && (filter ? filter(p) : true));
  if (!list.length) return <Text style={{ color: colors.muted }}>Uygun proje yok.</Text>;
  return (
    <View accessibilityLabel="Proje" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
      {list.map((p) => (
        <Chip key={p.id} label={p.title} selected={value === p.id} onPress={() => onChange(p)} />
      ))}
    </View>
  );
}

/**
 * Pick task(s) of one project: project chips → filterable open-task list (title search). Used by
 * the time entry link and the AI scope. `max` > 1 allows multi-select up to that many.
 */
export function TaskPicker({ accountId, selected, onChange, max = 1, boardId: fixedBoard, onBoard }: {
  accountId: AccountId;
  selected: PickedTask[];
  onChange: (tasks: PickedTask[]) => void;
  max?: number;
  /** Restrict to this project (no project chips). */
  boardId?: number;
  /** Notified with the loaded project (e.g. for its columns). */
  onBoard?: (b: BoardPayload) => void;
}) {
  const { backend } = useServices();
  const [chosen, setChosen] = useState<number | null>(fixedBoard ?? selected[0]?.boardId ?? null);
  const boardId = fixedBoard ?? chosen;
  const [q, setQ] = useState('');
  const board = useAsync(async () => {
    if (!boardId) return null;
    const b = await backend.board(accountId, boardId);
    onBoard?.(b);
    return b;
  }, [accountId, boardId]);
  const needle = q.trim().toLocaleLowerCase('tr');
  const tasks = (board.data?.tasks ?? []).filter((t: Task) => !t.archived && (!needle || t.title.toLocaleLowerCase('tr').includes(needle)));
  const isOn = (id: number) => selected.some((s) => s.id === id);
  const toggle = (t: Task) => {
    if (isOn(t.id)) return onChange(selected.filter((s) => s.id !== t.id));
    const next = { id: t.id, boardId: t.boardId, title: t.title };
    onChange(max === 1 ? [next] : selected.length >= max ? selected : [...selected, next]);
  };
  return (
    <View>
      {fixedBoard ? null : <ProjectChips accountId={accountId} value={boardId} onChange={(p) => { setChosen(p.id); onChange([]); }} />}
      {boardId ? (
        <>
          <TextInput accessibilityLabel="Görev ara" placeholder="Görev ara" placeholderTextColor={colors.muted} value={q} onChangeText={setQ} style={[ui.input, { marginBottom: space(2) }]} />
          {board.loading && !board.data ? <Loading /> : null}
          {board.error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{describeError(board.error)}</Text> : null}
          {board.data && !tasks.length ? <Text style={{ color: colors.muted }}>Görev yok.</Text> : null}
          <View accessibilityLabel={max === 1 ? 'Görev seçin' : `En çok ${max} görev seçin`} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
            {tasks.slice(0, 60).map((t) => (
              <Chip key={t.id} label={`${t.done ? '✓ ' : ''}${t.title}`} selected={isOn(t.id)} disabled={!isOn(t.id) && max > 1 && selected.length >= max} onPress={() => toggle(t)} />
            ))}
          </View>
          {tasks.length > 60 ? <Text style={{ color: colors.muted, fontSize: font.small }}>İlk 60 görev gösteriliyor; aramayı daraltın.</Text> : null}
        </>
      ) : null}
    </View>
  );
}
