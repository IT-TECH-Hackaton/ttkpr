import { client } from "@ttkpr/api-client";

// Same origin in dev (Vite proxy) and production (Caddy); cookies carry the session.
client.setConfig({ baseUrl: "", credentials: "include" });

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Result<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

const FIELD_NAMES: Record<string, string> = {
  email: "Email",
  name: "Имя",
  password: "Пароль",
  currentPassword: "Текущий пароль",
  newPassword: "Новый пароль",
  title: "Название",
  slug: "Адрес",
  role: "Роль",
};

interface FieldError {
  loc?: unknown[];
  type?: string;
  ctx?: Record<string, unknown>;
}

/** FastAPI's 422 item -> a sentence the organizer can act on. */
function fieldMessage({ loc, type, ctx }: FieldError): string {
  const key = String(loc?.at(-1) ?? "");
  const field = FIELD_NAMES[key] ?? "Поле";
  switch (type) {
    case "missing":
      return `${field}: обязательное поле`;
    case "string_too_short":
      return `${field}: не короче ${ctx?.min_length} символов`;
    case "string_too_long":
      return `${field}: не длиннее ${ctx?.max_length} символов`;
    default:
      return key === "email"
        ? "Проверьте email: адрес не похож на настоящий"
        : `${field}: неверное значение`;
  }
}

function messageOf(error: unknown, status: number): string {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    return [...new Set(detail.map((d) => fieldMessage(d as FieldError)))].join(". ");
  }
  if (status === 0) return "Нет связи с сервером";
  return `Ошибка сервера (${status})`;
}

/** Turns the generated client's { data, error } into a value or an ApiError. */
export async function unwrap<T>(request: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await request;
  const status = response?.status ?? 0;
  if (error !== undefined || !response?.ok) throw new ApiError(messageOf(error, status), status);
  return data as T;
}

/** Plain fetch for capture endpoints, which may authorise with a QR token instead of a cookie. */
export async function captureFetch<T>(url: string, init: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Capture-Token", token);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: "include" });
  } catch {
    throw new ApiError("Нет связи с сервером", 0);
  }
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(messageOf(body, response.status), response.status);
  return body as T;
}
