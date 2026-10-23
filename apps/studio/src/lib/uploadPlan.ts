import { uploadAsset } from "@ttkpr/api-client";
import { useState } from "react";
import { useDraft } from "../store";
import { unwrap } from "./api";
import { placementCorners, viewCenter, viewWidthMeters } from "./mapView";

/** Upload a plan image and lay it under the current level, fitted to the visible area. */
export function useUploadPlan(mapId: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setPending(true);
    setError(null);
    try {
      const { doc, addUnderlay } = useDraft.getState();
      const asset = await unwrap(uploadAsset({ path: { map_id: mapId }, body: { file } }));
      const center = viewCenter() ?? doc.venue.anchor;
      const widthM = (viewWidthMeters(doc.venue.anchor) ?? 60) * 0.8;
      addUnderlay({
        url: asset.url,
        opacity: 0.6,
        coordinates: placementCorners(doc.venue.anchor, {
          center,
          widthM,
          heightM: (widthM * asset.height) / asset.width,
          rotationDeg: 0,
        }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить план");
    } finally {
      setPending(false);
    }
  };

  return { upload, pending, error };
}
