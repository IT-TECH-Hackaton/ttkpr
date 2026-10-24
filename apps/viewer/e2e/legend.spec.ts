import { expect, test } from "@playwright/test";

// The first visit explains the marks; "?" brings the legend back later.
test("shows the legend once, then on demand", async ({ page }) => {
  await page.goto("/m/demo");
  const legend = page.getByRole("dialog", { name: "Обозначения на карте" });
  await expect(legend).toBeVisible();
  await page.getByRole("button", { name: "Понятно" }).click();
  await expect(legend).toBeHidden();

  await page.reload();
  await expect(page.getByLabel("Поиск по карте")).toBeVisible();
  await expect(legend).toBeHidden();
  await page.getByRole("button", { name: "Обозначения на карте" }).click();
  await expect(legend).toBeVisible();
});
