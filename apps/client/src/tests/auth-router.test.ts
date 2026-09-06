// @vitest-environment jsdom
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createAppRouter } from '../router/index.js';
import { useAuthStore } from '../stores/auth.js';

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => disposePinia(pinia));

describe('identity route guards', () => {
  it('waits for the server identity check and redirects anonymous visitors', async () => {
    const auth = useAuthStore();
    const restore = vi.spyOn(auth, 'ensureSession').mockResolvedValue();
    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    expect(restore).toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('allows an authenticated workspace and redirects guest-only pages', async () => {
    const auth = useAuthStore();
    auth.user = { id: 'a', username: 'alice' };
    vi.spyOn(auth, 'ensureSession').mockResolvedValue();
    const router = createAppRouter(createMemoryHistory());
    await router.push('/register');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('allows both authentication pages when anonymous', async () => {
    vi.spyOn(useAuthStore(), 'ensureSession').mockResolvedValue();
    const router = createAppRouter(createMemoryHistory());
    await router.push('/register');
    expect(router.currentRoute.value.path).toBe('/register');
    await router.push('/login');
    expect(router.currentRoute.value.path).toBe('/login');
  });
});

it.each(['/login', '/missing'])(
  'keeps an in-flight registration on its page instead of navigating to %s',
  async (destination) => {
    const auth = useAuthStore();
    vi.spyOn(auth, 'ensureSession').mockResolvedValue();
    const router = createAppRouter(createMemoryHistory());
    await router.push('/register');
    auth.busy = true;
    await router.push(destination);
    expect(router.currentRoute.value.path).toBe('/register');
    auth.busy = false;
    await router.push(destination);
    expect(router.currentRoute.value.path).toBe(destination);
  },
);
