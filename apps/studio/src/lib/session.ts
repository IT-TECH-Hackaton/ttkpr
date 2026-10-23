import { useQuery } from "@tanstack/react-query";
import { me, type UserOut } from "@ttkpr/api-client";
import { ApiError, unwrap } from "./api";

export const meQueryKey = ["me"] as const;

/** Current organizer, or null when logged out. */
export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: async (): Promise<UserOut | null> => {
      try {
        return await unwrap(me());
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
  });
}
