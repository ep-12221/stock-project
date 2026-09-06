import { createRouter, createWebHistory } from 'vue-router';
import type { RouterHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import AuthView from '../views/AuthView.vue';
import NotFoundView from '../views/NotFoundView.vue';
import { useAuthStore } from '../stores/auth.js';

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  const router = createRouter({
    history,
    routes: [
      { path: '/', name: 'home', component: HomeView, meta: { requiresAuth: true } },
      {
        path: '/login',
        name: 'login',
        component: AuthView,
        props: { mode: 'login' },
        meta: { guestOnly: true },
      },
      {
        path: '/register',
        name: 'register',
        component: AuthView,
        props: { mode: 'register' },
        meta: { guestOnly: true },
      },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView },
    ],
    scrollBehavior: () => ({ top: 0 }),
  });
  router.beforeEach(async (to, from) => {
    const auth = useAuthStore();
    if (from.meta.guestOnly && auth.busy) return false;
    await auth.ensureSession();
    if (to.meta.requiresAuth && !auth.user) return { name: 'login', replace: true };
    if (to.meta.guestOnly && auth.user) return { name: 'home', replace: true };
    return true;
  });
  return router;
}
export const router = createAppRouter();
