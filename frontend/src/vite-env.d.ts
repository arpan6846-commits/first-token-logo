/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_DEPLOYMENT?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_E2E_ACCOUNT?: string;
}
