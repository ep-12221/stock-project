import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { INITIAL_CASH_CENTS } from '@stock/shared';
import { z } from 'zod';
import { AppError } from '../domain/app-error.js';
import type { HumanUser } from '../domain/models.js';
import type { MemoryStore } from '../store/memory-store.js';
import type { SessionService } from './session.service.js';

const deriveKey = promisify(scrypt);
const credentialsSchema = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{3,20}$/, '用户名须为 3～20 位英文字母、数字或下划线'),
    password: z.string().min(8, '密码须为 8～64 个字符').max(64, '密码须为 8～64 个字符'),
  })
  .strict();

function parseCredentials(input: unknown) {
  const result = credentialsSchema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      result.error.issues[0]?.message ?? '请求格式不正确',
    );
  }
  return result.data;
}

export function createAuthService(store: MemoryStore, sessions: SessionService) {
  async function register(input: unknown, previousSessionId?: string) {
    const { username, password } = parseCredentials(input);
    const assertUnique = () => {
      if (store.usernames.has(username)) throw new AppError(409, 'USERNAME_EXISTS', '用户名已占用');
    };
    assertUnique();
    const passwordSalt = randomBytes(16).toString('hex');
    const passwordHash = ((await deriveKey(password, passwordSalt, 64)) as Buffer).toString('hex');

    // Recheck after async hashing; all following account mutations are synchronous.
    assertUnique();
    const user: HumanUser = {
      id: randomUUID(),
      username,
      passwordHash,
      passwordSalt,
      kind: 'USER',
      createdAt: new Date(store.now()).toISOString(),
    };
    store.users.set(user.id, user);
    store.usernames.set(username, user.id);
    store.accounts.set(user.id, {
      userId: user.id,
      cashBalanceCents: INITIAL_CASH_CENTS,
      frozenCashCents: 0,
      version: 0,
    });
    store.positions.set(user.id, new Map());
    const session = sessions.create(user.id);
    sessions.revoke(previousSessionId);
    return { user, session };
  }

  async function login(input: unknown, previousSessionId?: string) {
    const { username, password } = parseCredentials(input);
    const id = store.usernames.get(username);
    const user = id ? store.users.get(id) : undefined;
    // Unknown and reserved accounts still perform a derivation before returning the same error.
    const salt = user?.kind === 'USER' ? user.passwordSalt : randomBytes(16).toString('hex');
    const candidate = (await deriveKey(password, salt, 64)) as Buffer;
    const expected =
      user?.kind === 'USER' ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64);
    const matches = expected.length === candidate.length && timingSafeEqual(expected, candidate);
    if (!matches || user?.kind !== 'USER') {
      throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }
    const session = sessions.create(user.id);
    sessions.revoke(previousSessionId);
    return { user, session };
  }
  return { register, login };
}
