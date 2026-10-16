// Публичные страницы пререндерятся; игровые маршруты отключают пререндер у себя
// и открываются через fallback 200.html как клиентские экраны.
export const prerender = true;
export const trailingSlash = "never";
