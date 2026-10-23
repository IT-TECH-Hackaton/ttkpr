import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deletePanorama,
  listPanoramas,
  type PanoramaOut,
  type PanoramaUpdate,
  updatePanorama,
  uploadPanorama,
} from "@ttkpr/api-client";
import { unwrap } from "./api";

const key = (mapId: string) => ["panoramas", mapId] as const;
const busy = (p: PanoramaOut) => p.status === "uploading" || p.status === "processing";

/** Panoramas of a map; polls while any of them is still being captured or stitched. */
export function usePanoramas(mapId: string) {
  return useQuery({
    queryKey: key(mapId),
    queryFn: () => unwrap(listPanoramas({ path: { map_id: mapId } })),
    refetchInterval: (query) => (query.state.data?.some(busy) ? 2500 : 15_000),
  });
}

export function usePanoramaActions(mapId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: key(mapId) });
  return {
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: PanoramaUpdate }) =>
        unwrap(updatePanorama({ path: { pano_id: id }, body: patch })),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => unwrap(deletePanorama({ path: { pano_id: id } })),
      onSuccess: refresh,
    }),
    upload: useMutation({
      mutationFn: (input: { file: File; levelId: string; position: [number, number] }) =>
        unwrap(
          uploadPanorama({
            path: { map_id: mapId },
            body: {
              file: input.file,
              levelId: input.levelId,
              lon: input.position[0],
              lat: input.position[1],
            },
          }),
        ),
      onSuccess: refresh,
    }),
    refresh,
  };
}
