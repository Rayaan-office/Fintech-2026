import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import { readSetting, writeSetting } from "./storage";

const KEY = "copilot.privacy";

type PrivacyContextValue = { hidden: boolean; setHidden: (hidden: boolean) => void; toggle: () => void };

const PrivacyContext = createContext<PrivacyContextValue>({ hidden: false, setHidden: () => {}, toggle: () => {} });

export function PrivacyProvider({ children, initialHidden }: { children: ReactNode; initialHidden?: boolean }) {
  const [hidden, setHiddenState] = useState(() => initialHidden ?? readSetting(KEY) === "1");
  const setHidden = useCallback((next: boolean) => {
    setHiddenState(next);
    writeSetting(KEY, next ? "1" : "0");
  }, []);
  const toggle = useCallback(() => setHidden(!hidden), [hidden, setHidden]);
  const value = useMemo(() => ({ hidden, setHidden, toggle }), [hidden, setHidden, toggle]);
  return <PrivacyContext value={value}>{children}</PrivacyContext>;
}

export function usePrivacy(): PrivacyContextValue {
  return use(PrivacyContext);
}
