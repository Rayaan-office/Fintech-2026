import "@fontsource-variable/inter";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { createQueryClient } from "./api/queryClient";
import { Providers } from "./App";
import { applyTheme } from "./lib/theme";
import { createRouter } from "./router";

applyTheme();

const queryClient = createQueryClient();
const router = createRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
