import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { logout, logoutEverywhere } from "@ttkpr/api-client";
import { ThemeSwitch } from "@ttkpr/ui";
import { LogOut, Map as MapIcon, MonitorSmartphone, UserRound } from "lucide-react";
import { unwrap } from "../lib/api";
import { meQueryKey, useMe } from "../lib/session";
import { MenuDivider, MenuItem, Popover } from "./Popover";

export function initials(name: string | undefined) {
  return (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

export function Avatar({ name, size = 36 }: { name: string | undefined; size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full bg-emerald-600 font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </span>
  );
}

/** Account menu: profile, my maps, sign out (here or on every device). */
export function UserMenu() {
  const { data: user } = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const signOut = async (everywhere: boolean) => {
    await unwrap(everywhere ? logoutEverywhere() : logout());
    queryClient.clear();
    queryClient.setQueryData(meQueryKey, null);
    await navigate({ to: "/login", search: { next: undefined } });
  };

  return (
    <Popover
      align="right"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label="Аккаунт"
          className="rounded-full ring-offset-2 focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Avatar name={user?.name} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flex items-center gap-3 px-3 py-2">
            <Avatar name={user?.name} size={40} />
            <div className="min-w-0">
              <p className="truncate font-medium">{user?.name}</p>
              <p className="truncate text-xs text-muted">{user?.email}</p>
            </div>
          </div>
          <MenuDivider />
          <MenuItem
            icon={<UserRound />}
            onClick={() => {
              close();
              void navigate({ to: "/profile" });
            }}
          >
            Профиль и безопасность
          </MenuItem>
          <MenuItem
            icon={<MapIcon />}
            onClick={() => {
              close();
              void navigate({ to: "/" });
            }}
          >
            Мои карты
          </MenuItem>
          <div className="px-3 py-2">
            <p className="pb-1.5 text-xs text-muted">Тема</p>
            <ThemeSwitch />
          </div>
          <MenuDivider />
          <MenuItem icon={<LogOut />} onClick={() => void signOut(false)}>
            Выйти
          </MenuItem>
          <MenuItem icon={<MonitorSmartphone />} danger onClick={() => void signOut(true)}>
            Выйти на всех устройствах
          </MenuItem>
        </>
      )}
    </Popover>
  );
}
