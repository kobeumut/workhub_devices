/**
 * Normalized Nextcloud server base: `https://host[:port][/subdir]`, no trailing slash,
 * no `/index.php`, no query/fragment/userinfo. The sub-directory is preserved.
 */
export type ServerBase = string & { readonly __brand: 'ServerBase' };

export class ServerUrlError extends Error {
  constructor(
    readonly code: 'empty' | 'invalid' | 'insecure' | 'userinfo' | 'query' | 'fragment',
    message: string,
  ) {
    super(message);
    this.name = 'ServerUrlError';
  }
}

export interface NormalizeOptions {
  /** Plain http is rejected unless explicitly allowed (local development only). */
  allowInsecureHttp?: boolean;
}

export function normalizeServerUrl(input: string, options: NormalizeOptions = {}): ServerBase {
  const raw = input.trim();
  if (!raw) throw new ServerUrlError('empty', 'Sunucu adresi boş.');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ServerUrlError('invalid', 'Geçersiz sunucu adresi.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowInsecureHttp)) {
    throw new ServerUrlError('insecure', 'Yalnız HTTPS sunucular desteklenir.');
  }
  if (url.username || url.password) {
    throw new ServerUrlError('userinfo', 'Adres kullanıcı adı/parola içeremez.');
  }
  // `URL` drops an empty "?"/"#"; check the raw text too so "https://x/?" is rejected.
  if (url.search || withScheme.includes('?')) throw new ServerUrlError('query', 'Adres sorgu parametresi içeremez.');
  if (url.hash || withScheme.includes('#')) throw new ServerUrlError('fragment', 'Adres # parçası içeremez.');
  if (!url.hostname) throw new ServerUrlError('invalid', 'Geçersiz sunucu adresi.');

  let path = url.pathname.replace(/\/+$/, '');
  // Users often paste a page URL; keep only the installation root.
  const appIdx = path.search(/\/(index\.php|apps|ocs|remote\.php|login)(\/|$)/);
  if (appIdx >= 0) path = path.slice(0, appIdx);
  return `${url.protocol}//${url.host.toLowerCase()}${path}` as ServerBase;
}

/** True when `candidate` is on the same origin and inside the installation root of `base`. */
export function isWithinServer(base: ServerBase, candidate: string): boolean {
  let b: URL;
  let c: URL;
  try {
    b = new URL(base);
    c = new URL(candidate);
  } catch {
    return false;
  }
  if (b.origin !== c.origin || c.username || c.password) return false;
  const root = b.pathname.replace(/\/+$/, '');
  return root === '' || c.pathname === root || c.pathname.startsWith(`${root}/`);
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
