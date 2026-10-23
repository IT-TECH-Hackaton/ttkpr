import { expect, test } from "@playwright/test";

// A visitor scans a "Вы здесь" sign, asks for a route and walks it through the panoramas.
test("routes from a QR sign and walks the route through panoramas", async ({ page }) => {
  await page.goto("/m/demo?here=p-stand-a1");
  await expect(page.getByText("Вы здесь:")).toBeVisible();

  await page.getByLabel("Поиск по карте").fill("Регистрация");
  await page
    .getByRole("button", { name: /Регистрация/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Маршрут сюда" }).click();

  await expect(page.getByRole("button", { name: /Откуда.*Вы здесь · Стенд A1/ })).toBeVisible();
  const steps = page.getByRole("list", { name: "Шаги маршрута" });
  await expect(steps).toContainText("Пройдите через дверь в «Коридор»");
  await expect(steps).toContainText("Вы на месте: «Регистрация»");

  await page.getByRole("button", { name: "Пройти по панорамам" }).click();
  await expect(page.getByText("1 из 2")).toBeVisible();
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await expect(page.getByText("2 из 2")).toBeVisible();
  await page.getByRole("button", { name: "Готово" }).click();
  await expect(steps).toBeVisible();
});

test("picks the start by tapping the plan", async ({ page }) => {
  await page.goto("/m/demo?to=p-stage");
  await page.getByRole("button", { name: /Откуда/ }).click();
  await page.getByText("Указать на плане").click();
  await expect(page.getByText("Коснитесь плана там, откуда идёте")).toBeVisible();
  // Outside the building: refused with a hint, still picking.
  await page.mouse.click(20, 200);
  await expect(page.getByText("Здесь нет прохода")).toBeVisible();
});

test("opens an organizer's tour across the yard to the second building", async ({ page }) => {
  await page.goto("/m/demo");
  await page.getByRole("button", { name: /Обход хакатона/ }).click();
  await expect(page.getByText("Маршрут организатора")).toBeVisible();
  const steps = page.getByRole("list", { name: "Шаги маршрута" });
  await expect(steps).toContainText("Точка 2 из 6: «Шатёр партнёров»");
  await expect(steps).toContainText("Поднимитесь по лестнице на 2 этаж");
  await expect(steps).toContainText("Вы на месте: «Менторы»");
});
