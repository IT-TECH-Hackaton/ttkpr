import type { MapSummary } from "@ttkpr/api-client";

// Mirrors apps/api/src/api/permissions.py; the API is the authority, the UI only hides
// what the current role cannot do.
export type Permission =
  | "view"
  | "capture"
  | "edit"
  | "publish"
  | "share"
  | "manage_team"
  | "delete";
export type Role = MapSummary["role"];

export const ROLE_LABELS: Record<NonNullable<Role>, string> = {
  owner: "Владелец",
  editor: "Редактор",
  photographer: "Съёмщик",
  viewer: "Наблюдатель",
};

export const ROLE_HINTS: Record<NonNullable<Role>, string> = {
  owner: "Всё: план, панорамы, публикация, команда, удаление карты",
  editor: "План, точки, панорамы, публикация и ссылки — без управления командой",
  photographer: "Снимает и загружает панорамы, видит план",
  viewer: "Смотрит черновик и предпросмотр, ничего не меняет",
};

export function can(map: Pick<MapSummary, "permissions"> | undefined, permission: Permission) {
  return Boolean(map?.permissions?.includes(permission));
}
