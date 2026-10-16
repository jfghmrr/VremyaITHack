<script lang="ts">
  import LegalPage from "#lib/legal/LegalPage.svelte";
  import ComplaintForm from "#lib/legal/ComplaintForm.svelte";
  import { documents, operator } from "#lib/legal/operator.ts";
</script>

<svelte:head><title>Контакты — Перепев</title></svelte:head>

<LegalPage title="Контакты" updated={documents.contacts}>
  <h2>Оператор</h2>
  <p>Сайт «Перепев» и обработку данных на нём ведёт <b>{operator.name}</b>. Это демонстрационная версия проекта для хакатона.</p>
  <p>
    Реквизиты и почтовый адрес оператор публикует на этой странице перед публичным запуском сервиса вместе с номером в реестре операторов персональных данных Роскомнадзора. Мы не указываем
    вымышленные реквизиты.
  </p>
  <h2>Как связаться</h2>
  <p>
    Вопросы о данных, отзыв согласия, жалобы на материалы и заявки правообладателей принимаются через форму ниже. Удалить кабинет и все его данные можно сразу в <a href="/account">настройках аккаунта</a>.
  </p>
  <ComplaintForm />
</LegalPage>
