import { useQuery } from "@tanstack/react-query";
import { createCaptureToken } from "@ttkpr/api-client";
import { Button } from "@ttkpr/ui";
import { unwrap } from "../lib/api";
import { captureLink } from "../lib/links";
import { QrCode } from "./QrCode";

interface Props {
  mapId: string;
  levelId: string;
  position: [number, number];
  onClose: () => void;
}

/** Desktop -> phone hand-off: the QR opens the capture screen with a short-lived token. */
export function CaptureQrDialog({ mapId, levelId, position, onClose }: Props) {
  const token = useQuery({
    queryKey: ["capture-token", mapId],
    queryFn: () => unwrap(createCaptureToken({ path: { map_id: mapId } })),
    staleTime: 30 * 60_000,
  });
  const link = token.data ? captureLink({ mapId, token: token.data.token, levelId, position }) : "";
  const insecure = link.startsWith("http://");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="capture-qr-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm space-y-4 rounded-2xl bg-bg p-5 shadow-2xl">
        <div className="space-y-1">
          <h2 id="capture-qr-title" className="text-lg font-semibold">
            Снять панораму с телефона
          </h2>
          <p className="text-sm text-muted">
            Отсканируйте код камерой телефона, встаньте в отмеченную точку и следуйте подсказкам.
            Ссылка действует 2 часа.
          </p>
        </div>
        <div className="grid place-items-center rounded-xl bg-white p-3">
          {link ? (
            <QrCode value={link} size={240} label="QR-код для съёмки с телефона" />
          ) : (
            <div className="grid h-60 w-60 place-items-center text-muted">
              {token.error ? "Не удалось получить ссылку" : "Готовим ссылку…"}
            </div>
          )}
        </div>
        {insecure && (
          <p className="rounded-xl bg-amber-100 p-3 text-sm text-amber-900">
            Студия открыта по HTTP: камера телефона потребует HTTPS. Запустите её с{" "}
            <code>HTTPS=1</code>.
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={!link}
            onClick={() => void navigator.clipboard.writeText(link)}
          >
            Скопировать ссылку
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={!link}
            onClick={() => window.open(link, "_blank")}
          >
            Открыть здесь
          </Button>
        </div>
        <Button className="w-full" onClick={onClose}>
          Готово
        </Button>
      </div>
    </div>
  );
}
