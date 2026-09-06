// @vitest-environment jsdom
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import AuthView from '../views/AuthView.vue';
import { useAuthStore } from '../stores/auth.js';

let pinia: ReturnType<typeof createPinia>;
const wrappers: Array<{ unmount: () => void }> = [];
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  disposePinia(pinia);
});

async function setup(mode: 'login' | 'register') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/' + mode);
  await router.isReady();
  const wrapper = mount(AuthView, { props: { mode }, global: { plugins: [pinia, router] } });
  wrappers.push(wrapper);
  return { wrapper, router, auth: useAuthStore() };
}
async function fill(
  wrapper: Awaited<ReturnType<typeof setup>>['wrapper'],
  username = 'alice',
  password = 'password123',
) {
  await wrapper.get('[name="username"]').setValue(username);
  await wrapper.get('[name="password"]').setValue(password);
}

describe('login and registration forms', () => {
  it.each(['login', 'register'] as const)(
    'submits %s and enters the workspace after success',
    async (mode) => {
      const { wrapper, router, auth } = await setup(mode);
      const submit = vi.spyOn(auth, mode).mockResolvedValue();
      await fill(wrapper);
      if (mode === 'register')
        await wrapper.get('[name="confirmPassword"]').setValue('password123');
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(submit).toHaveBeenCalledWith({ username: 'alice', password: 'password123' });
      expect(router.currentRoute.value.path).toBe('/');
      expect((wrapper.get('[name="password"]').element as HTMLInputElement).value).toBe('');
    },
  );

  it('rejects invalid usernames and short passwords before any API call', async () => {
    const { wrapper, auth } = await setup('register');
    const submit = vi.spyOn(auth, 'register').mockResolvedValue();
    await fill(wrapper, 'a!', 'short');
    await wrapper.get('form').trigger('submit');
    expect(submit).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('用户名');
  });

  it('rejects mismatched confirmation before registration', async () => {
    const { wrapper, auth } = await setup('register');
    const submit = vi.spyOn(auth, 'register').mockResolvedValue();
    await fill(wrapper);
    await wrapper.get('[name="confirmPassword"]').setValue('different');
    await wrapper.get('form').trigger('submit');
    expect(submit).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('不一致');
  });

  it('blocks duplicate submit while the first login is pending', async () => {
    const { wrapper, auth } = await setup('login');
    let complete!: () => void;
    const submit = vi.spyOn(auth, 'login').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    await fill(wrapper);
    await wrapper.get('form').trigger('submit');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    expect(submit).toHaveBeenCalledTimes(1);
    complete();
    await flushPromises();
  });

  it('shows server validation errors and allows correction', async () => {
    const { wrapper, auth } = await setup('login');
    vi.spyOn(auth, 'login').mockRejectedValue(new Error('用户名或密码错误'));
    await fill(wrapper);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('用户名或密码错误');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
    expect((wrapper.get('[name="username"]').element as HTMLInputElement).value).toBe('alice');
  });
});

describe('authentication page operation guard', () => {
  it('removes the page-switch link while submitting and restores it after failure', async () => {
    const { wrapper, auth } = await setup('register');
    let reject!: (cause: Error) => void;
    vi.spyOn(auth, 'register').mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    await fill(wrapper);
    await wrapper.get('[name="confirmPassword"]').setValue('password123');
    await wrapper.get('form').trigger('submit');
    const linkWhilePending = wrapper.find('.auth-switch a').exists();
    reject(new Error('retry'));
    await flushPromises();
    expect(linkWhilePending).toBe(false);
    expect(wrapper.get('.auth-switch a').attributes('href')).toBe('/login');
  });

  it('blocks a newly mounted form when another view owns the session operation', async () => {
    const { wrapper, auth } = await setup('login');
    const submit = vi.spyOn(auth, 'login').mockResolvedValue();
    await fill(wrapper);
    auth.busy = true;
    await wrapper.get('form').trigger('submit');
    expect(submit).not.toHaveBeenCalled();
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.auth-switch a').exists()).toBe(false);
  });
});
