// Build-time settings read from import.meta.env (app/.env, or the host's environment).
interface ImportMetaEnv {
  readonly VITE_NETWORK?: string;
  readonly VITE_CONTRACT?: string;
  readonly VITE_RELAYER_URL?: string;
  readonly VITE_TESTNET_CONTRACT?: string;
  readonly VITE_TESTNET_RELAYER_URL?: string;
  readonly VITE_MAINNET_CONTRACT?: string;
  readonly VITE_MAINNET_RELAYER_URL?: string;
  readonly VITE_RPC?: string;
  /** a developer's own NEAR AI Cloud key, local builds only */
  readonly VITE_NEARAI_KEY?: string;
}
