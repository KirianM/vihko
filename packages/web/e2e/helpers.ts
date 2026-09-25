import { expect, type Browser, type Page } from '@playwright/test'
import { PASSWORD } from './env.ts'

/** Own session (isolated context) with the person already signed in and the note open. */
export async function signIn(browser: Browser, user: string, note?: string): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(note ? `/?note=${encodeURIComponent(note)}` : '/')
  await page.getByLabel('Nombre de usuario').fill(user)
  await page.getByLabel('Contraseña').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).last().click()
  if (note) await expect(page.locator('.cm-content')).toBeVisible()
  else await expect(page.getByRole('treegrid')).toBeVisible()
  return page
}

export const editorText = (page: Page) => page.locator('.cm-content').innerText()
