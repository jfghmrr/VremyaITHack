// HTTP-клиент API. Изменяющие запросы помечаются заголовком: сервер принимает их
// только со своего Origin и с этим заголовком (защита от CSRF вместе с SameSite=Strict).
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const OFFLINE = "Нет связи с сервером. Одиночное пение работает, кабинет и дуэли временно недоступны.";

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method,
      credentials: "same-origin",
      headers:
        method === "GET" ? {} : { "content-type": "application/json", "x-perepev-request": "1" },
      body: method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
    });
  } catch {
    throw new ApiError(OFFLINE, 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      typeof data.error === "string" ? data.error : response.status >= 500 ? OFFLINE : "Запрос не выполнен.",
      response.status,
    );
  return data as T;
}
