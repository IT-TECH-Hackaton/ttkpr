import { expect, test } from "@playwright/test";

// The demo map is static, so the test needs no API: save it, cut the network, reload.
test("a saved map opens without internet, panoramas included", async ({ page, context }) => {
  await page.goto("/m/demo");
  // Wait until the service worker controls the page (first visit installs it).
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(registration.active && navigator.serviceWorker.controller);
  });

  await page.getByRole("button", { name: /Сохранить карту офлайн/ }).click();
  await expect(page.getByText(/Доступна без интернета/)).toBeVisible({ timeout: 30_000 });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("Нет сети — показываем сохранённую версию карты")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Демо-площадка хакатона" })).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();

  // Search works offline, then open a panorama of a saved point.
  await page.getByRole("searchbox", { name: "Поиск по карте" }).fill("кофе");
  await page.getByRole("button", { name: "Кофе-поинт Еда и кофе · 1 этаж" }).click();
  const failed: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url().includes("/demo/")) failed.push(r.url());
  });
  await page.getByRole("button", { name: "Панорама" }).click();
  await expect(page.locator(".psv-container")).toBeVisible();
  await page.waitForFunction(() => {
    const psv = (window as unknown as { psv?: { state: { ready: boolean } } }).psv;
    return document.querySelector(".psv-canvas") && (psv === undefined || psv.state.ready);
  });
  await page.waitForTimeout(1500);
  expect(failed).toEqual([]);

  // The landing page lists it under "Мои карты".
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Демо-площадка хакатона/ })).toBeVisible();
});
