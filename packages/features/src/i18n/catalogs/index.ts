import type { Catalog, CatalogPair } from '../core';
import ai from './ai';
import common from './common';
import dashboards from './dashboards';
import goals from './goals';
import modules from './modules';
import requests from './requests';
import shell from './shell';
import talk from './talk';
import tasks from './tasks';
import time from './time';
import workflows from './workflows';

export { common };

/** Per-screen catalogs, exposed as `messages.<name>` (see `../messages.ts`). */
export const screens = { ai, dashboards, goals, modules, requests, shell, talk, tasks, time, workflows };

/** Every catalog, for the parity tests. */
export const allCatalogs: Record<string, CatalogPair<Catalog>> = { common, ...screens };
