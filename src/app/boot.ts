// Shared start-up: theme, routing, render loop and timers, for either runtime.
import type { Page } from './state.ts';
import { S, PAGES, startRuntime, onRender, tick } from './state.ts';
import type { Runtime } from './runtime.ts';
import { renderBanners, renderHeader, renderNav, renderPage } from './pages.ts';
import { clear, h, storageGet } from '../ui/dom.ts';

export function boot(makeRuntime: () => Promise<Runtime>): void {
  const root = document.getElementById('app') as HTMLElement;
  const pageFromHash = (): Page => (PAGES.find((p) => p.id === location.hash.replace(/^#/, ''))?.id ?? 'overview') as Page;
  let lastPage: Page | null = null;
  let pageEl: HTMLElement | null = null;

  const render = (): void => {
    const header = renderHeader();
    const nav = renderNav();
    const banners = renderBanners();
    const pageChanged = lastPage !== S.page;
    // Keep a form the user is editing intact; background refreshes only update the chrome.
    const editing = !pageChanged && S.formDirty && S.page === 'portfolio';
    const toast = S.toast ? h('div', { class: `toast toast-${S.toast.tone}`, role: 'status' }, S.toast.text) : null;
    if (editing && pageEl) {
      root.querySelector('header.top')?.replaceWith(header);
      root.querySelector('nav.tabs')?.replaceWith(nav);
      root.querySelector('.toast')?.remove();
      if (toast) root.append(toast);
      return;
    }
    const scroll = window.scrollY;
    clear(root);
    pageEl = h('main', { class: 'main', id: 'main' }, banners, renderPage(S.page));
    root.append(header, nav, pageEl);
    if (toast) root.append(toast);
    if (pageChanged) {
      window.scrollTo(0, 0);
      lastPage = S.page;
    } else window.scrollTo(0, scroll);
  };

  const theme = storageGet('tqqq-theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
  S.page = pageFromHash();
  onRender(render);
  window.addEventListener('hashchange', () => {
    S.page = pageFromHash();
    S.formDirty = false;
    render();
  });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => render());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
  render();
  void startRuntime(makeRuntime);
  setInterval(tick, 60000);
}
