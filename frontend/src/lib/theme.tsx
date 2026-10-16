import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { readSetting, writeSetting } from "./storage";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "copilot.theme";

type ThemeContextValue = { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void };
const ThemeContext = createContext<ThemeContextValue>({ theme: "system", setTheme: () => {} });

function stored(): ThemeChoice {
  const v = readSetting(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(choice: ThemeChoice = stored()): void {
  const dark = choice === "dark" || (choice === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", Boolean(dark));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(stored);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      setTheme: (t: ThemeChoice) => {
        setThemeState(t);
        writeSetting(KEY, t);
      },
    }),
    [theme],
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  return use(ThemeContext);
}
