import { expect, test } from "@playwright/test";

// The first visit walks through three steps and the legend; "?" brings the legend back later.
test("shows the intro once, then the legend on demand", async ({ page }) => {
  await page.goto("/m/demo");
  await expect(page.getByRole("dialog", { name: "Найдите место" })).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Дальше" }).click();
  const legend = page.getByRole("dialog", { name: "Обозначения на карте" });
  await expect(legend).toBeVisible();
  await page.getByRole("button", { name: "Понятно" }).click();
  await expect(legend).toBeHidden();

  await page.reload();
  await expect(page.getByLabel("Поиск по карте")).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Обозначения на карте" }).click();
  await expect(legend).toBeVisible();
});
