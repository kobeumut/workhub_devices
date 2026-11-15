import { common, screens } from './catalogs';
import { createMessages } from './core';

/** Shared texts: `t.save`, `t.errNetwork`, … Reads resolve against the active locale. */
export const t = createMessages(common);

/**
 * Per-screen texts: `messages.workflows.title`. Keep a screen's strings in its own catalog
 * (`./catalogs/<screen>.ts`) so a catalog stays small and parallel edits do not collide.
 */
export const messages = {
  ai: createMessages(screens.ai),
  dashboards: createMessages(screens.dashboards),
  goals: createMessages(screens.goals),
  modules: createMessages(screens.modules),
  requests: createMessages(screens.requests),
  shell: createMessages(screens.shell),
  talk: createMessages(screens.talk),
  tasks: createMessages(screens.tasks),
  time: createMessages(screens.time),
  workflows: createMessages(screens.workflows),
};
