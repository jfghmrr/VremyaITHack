// Типы SvelteKit для приложения. page.state — состояние неглубокой навигации (goto с shallow: true).
declare global {
  namespace App {
    interface PageState {
      /** Меню разделов на телефоне открыто: отдельная запись в истории, «Назад» его закрывает. */
      menu?: boolean;
    }
  }
}

export {};
