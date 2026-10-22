import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://localhost:8123" },
  webServer: {
    command: "python3 -m http.server 8123 -b 127.0.0.1 -d site",
    url: "http://localhost:8123",
    reuseExistingServer: !process.env.CI,
  },
});
