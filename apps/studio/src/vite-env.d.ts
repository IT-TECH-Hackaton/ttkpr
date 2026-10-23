/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LAN_HOST?: string;
  /** Public origin of the deployment (tunnel or production), e.g. https://map.example.ru */
  readonly VITE_PUBLIC_URL?: string;
}
