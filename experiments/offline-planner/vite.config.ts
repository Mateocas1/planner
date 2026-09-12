import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const testIdentity = mode === "sw-update-old" || mode === "sw-update-new"
    ? mode
    : undefined;

  return {
    plugins: [
      react(),
      {
        name: "offline-planner-test-identity",
        transformIndexHtml(html) {
          return testIdentity
            ? html.replace("</head>", `<meta name="offline-planner-build" content="${testIdentity}"></head>`)
            : html;
        },
      },
      VitePWA({
        registerType: "prompt",
        injectRegister: false,
        manifest: false,
      }),
    ],
  };
});
