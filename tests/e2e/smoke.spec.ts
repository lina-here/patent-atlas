import { test, expect } from "./fixtures";

test("site root is served", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
});
