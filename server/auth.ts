// Password sign-in with an HMAC-signed session cookie. Changing the password signs every session out.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'tqqq_session';
const SESSION_DAYS = 30;

export class Auth {
  readonly required: boolean;
  private secret: Buffer;
  private pwHash: Buffer | null;

  constructor(password: string | null, secret: string) {
    this.required = !!password;
    this.pwHash = password ? createHash('sha256').update(password, 'utf8').digest() : null;
    this.secret = createHash('sha256').update(secret + '|' + (this.pwHash ? this.pwHash.toString('hex') : 'open')).digest();
  }

  static newSecret(): string {
    return randomBytes(32).toString('hex');
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(now = Date.now()): { value: string; maxAge: number } {
    const exp = now + SESSION_DAYS * 86400000;
    return { value: `${exp}.${this.sign('v1:' + exp)}`, maxAge: SESSION_DAYS * 86400 };
  }

  valid(cookieHeader: string | undefined, now = Date.now()): boolean {
    if (!this.required) return true;
    const raw = parseCookies(cookieHeader)[COOKIE];
    if (!raw) return false;
    const [expStr, sig] = raw.split('.');
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < now || !sig) return false;
    const want = Buffer.from(this.sign('v1:' + exp));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** Constant-time password check. Repeated failures are counted by the caller (see app.ts). */
  check(password: unknown): boolean {
    if (!this.pwHash) return true;
    return typeof password === 'string' && password.length <= 512 && timingSafeEqual(createHash('sha256').update(password, 'utf8').digest(), this.pwHash);
  }

  cookie(value: string, maxAge: number, secure: boolean): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure: boolean): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
