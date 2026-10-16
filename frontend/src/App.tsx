import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrivacyProvider } from "@/lib/privacy";
import { ThemeProvider, useTheme } from "@/lib/theme";

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="bottom-right" closeButton toastOptions={{ duration: 5000 }} />;
}

export function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <PrivacyProvider>
          <MotionConfig reducedMotion="user">
            <TooltipProvider delayDuration={300}>
              {children}
              <ThemedToaster />
            </TooltipProvider>
          </MotionConfig>
        </PrivacyProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
